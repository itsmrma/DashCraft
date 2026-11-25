import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/* ----- Rounded Live Blur -----
 *
 * Shows the live content behind the dock (windows included) blurred, instead
 * of the static wallpaper. A Clutter.Clone of the window group provides the
 * live backdrop; Shell.BlurEffect blurs it smoothly on the GPU and a
 * Clutter.OffscreenEffect clips it to the dock's rounded corners.
 */

const ROUNDED_DECLARATIONS = `
uniform vec2 dc_size;
uniform float dc_radius;
float dc_rounded_box(vec2 p, vec2 half_size, float r) {
    vec2 q = abs(p) - half_size + vec2(r);
    return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
`;

const ROUNDED_POST = `
vec2 dc_pos = cogl_tex_coord0_in.xy * dc_size;
vec2 dc_half = dc_size * 0.5;
float dc_r = min(dc_radius, min(dc_half.x, dc_half.y));
float dc_d = dc_rounded_box(dc_pos - dc_half, dc_half, dc_r);
cogl_color_out *= 1.0 - smoothstep(-0.5, 0.5, dc_d);
`;

const RoundedClipEffect = GObject.registerClass(class DashCraftRoundedClipEffect extends Clutter.OffscreenEffect {
    _init(getRadius) {
        super._init();
        this._getRadius = getRadius;
        this._snippetAdded = false;
        this._sizeLocation = -1;
        this._radiusLocation = -1;
    }

    vfunc_paint_target(node, paintContext) {
        const pipeline = this.get_pipeline();
        if (pipeline) {
            if (!this._snippetAdded) {
                const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
                    ROUNDED_DECLARATIONS, ROUNDED_POST);
                pipeline.add_snippet(snippet);
                this._sizeLocation = pipeline.get_uniform_location('dc_size');
                this._radiusLocation = pipeline.get_uniform_location('dc_radius');
                this._snippetAdded = true;
            }
            const texture = this.get_texture();
            if (texture && this._sizeLocation > -1) {
                pipeline.set_uniform_float(this._sizeLocation, 2, 1,
                    [texture.get_width(), texture.get_height()]);
            }
            if (this._radiusLocation > -1)
                pipeline.set_uniform_float(this._radiusLocation, 1, 1, [this._getRadius()]);
        }
        super.vfunc_paint_target(node, paintContext);
    }

    updateRadius() {
        this.queue_repaint();
    }
});

const BackdropContainer = GObject.registerClass(class DashCraftBackdrop extends St.Widget {
    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }
});

/* ----- Backdrop ----- */

export class Blur {
    constructor(dash, settings) {
        this._dash = dash;
        this._settings = settings;
        this._connections = [];
        this._geometryConnections = [];
        this._updateId = 0;
        this._backdrop = null;
        this._blurActor = null;
        this._clone = null;
        this._blurEffect = null;
        this._effect = null;
        this._lastRect = null;
        this._lastStage = null;
        this._lastTranslation = null;
        this._redirect = dash.offscreen_redirect;
        this._enabledId = settings.connect('changed::blur-enabled', () => this._sync());
        this._radiusId = settings.connect('changed::blur-radius', () => this._radiusChanged());
        this._sync();
    }

    _connect(object, signal, callback) {
        this._connections.push([object, object.connect(signal, callback)]);
    }

    _cornerRadius() {
        const node = this._dash._background.get_theme_node();
        return Math.max(
            node.get_border_radius(St.Corner.TOPLEFT),
            node.get_border_radius(St.Corner.TOPRIGHT),
            node.get_border_radius(St.Corner.BOTTOMLEFT),
            node.get_border_radius(St.Corner.BOTTOMRIGHT));
    }

    _sync() {
        if (this._settings.get_boolean('blur-enabled'))
            this._enable();
        else
            this._disable();
    }

    _enable() {
        if (this._backdrop)
            return;
        const dash = this._dash;

        this._backdrop = new BackdropContainer({
            name: 'dashcraft-blur-backdrop',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            reactive: false,
        });
        this._blurActor = new St.Widget({
            clip_to_allocation: true,
            reactive: false,
            visible: false,
        });
        this._clone = new Clutter.Clone({source: global.window_group});
        this._blurEffect = new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius: this._settings.get_int('blur-radius'),
            brightness: 1.0,
        });
        this._effect = new RoundedClipEffect(() => this._cornerRadius());
        this._blurActor.add_child(this._clone);
        this._blurActor.add_effect(this._blurEffect);
        this._blurActor.add_effect(this._effect);
        this._backdrop.add_child(this._blurActor);
        dash.insert_child_below(this._backdrop, dash._background);

        // The native dash caches its painting offscreen, which would freeze the
        // live backdrop; let it redirect only while fading instead.
        dash.offscreen_redirect = Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY;

        const schedule = () => this._queueUpdate();
        for (const actor of [dash, dash._background, this._backdrop]) {
            this._geometryConnections.push([actor,
                actor.connect('notify::allocation', schedule)]);
        }
        this._geometryConnections.push([dash,
            dash.connect('notify::translation-y', schedule)]);
        const host = dash.get_parent();
        if (host) {
            this._geometryConnections.push([host,
                host.connect('notify::translation-y', schedule)]);
        }
        // The window group does not reflect the overview, so hide the backdrop there.
        this._geometryConnections.push([Main.overview,
            Main.overview.connect('showing', () => this._backdrop?.hide())]);
        this._geometryConnections.push([Main.overview,
            Main.overview.connect('hidden', () => this._backdrop?.show())]);
        if (Main.overview.visible)
            this._backdrop.hide();
        this._queueUpdate();
    }

    _disable() {
        if (!this._backdrop)
            return;
        for (const [object, id] of this._geometryConnections)
            object.disconnect(id);
        this._geometryConnections = [];
        if (this._updateId) {
            global.stage.disconnect(this._updateId);
            this._updateId = 0;
        }
        this._dash.offscreen_redirect = this._redirect;
        this._backdrop.destroy();
        this._backdrop = this._blurActor = this._clone = this._blurEffect = this._effect = null;
        this._lastRect = this._lastStage = this._lastTranslation = null;
    }

    _radiusChanged() {
        if (this._blurEffect)
            this._blurEffect.radius = this._settings.get_int('blur-radius');
        this._effect?.updateRadius();
        this._queueUpdate();
    }

    _queueUpdate() {
        if (this._updateId || !this._backdrop)
            return;
        // Read geometry after pending layout, before the stage is painted.
        this._updateId = global.stage.connect('before-update', () => {
            global.stage.disconnect(this._updateId);
            this._updateId = 0;
            this._update();
        });
        global.stage.schedule_update();
    }

    _update() {
        if (!this._backdrop || !this._dash._background.has_allocation() ||
            !this._backdrop.has_allocation())
            return;
        const bgBox = this._dash._background.get_allocation_box();
        const backdropBox = this._backdrop.get_allocation_box();
        const width = bgBox.x2 - bgBox.x1;
        const height = bgBox.y2 - bgBox.y1;
        if (width <= 0 || height <= 0)
            return;
        const relX = bgBox.x1 - backdropBox.x1;
        const relY = bgBox.y1 - backdropBox.y1;
        const rect = [relX, relY, width, height];
        if (!this._lastRect || rect.some((v, i) => v !== this._lastRect[i])) {
            this._lastRect = rect;
            this._blurActor.set_position(relX, relY);
            this._blurActor.set_size(width, height);
        }
        const stageSize = [global.stage.width, global.stage.height];
        if (!this._lastStage || stageSize.some((v, i) => v !== this._lastStage[i])) {
            this._lastStage = stageSize;
            this._clone.set_size(...stageSize);
        }
        const [stageX, stageY] = this._dash._background.get_transformed_position();
        if (!this._lastTranslation || stageX !== this._lastTranslation[0] ||
            stageY !== this._lastTranslation[1]) {
            this._lastTranslation = [stageX, stageY];
            this._clone.set_translation(-stageX, -stageY, 0);
        }
        if (!this._blurActor.visible)
            this._blurActor.show();
        this._effect?.updateRadius();
    }

    /* ----- Cleanup ----- */

    destroy() {
        this._settings.disconnect(this._enabledId);
        this._settings.disconnect(this._radiusId);
        this._disable();
        for (const [object, id] of this._connections)
            object.disconnect(id);
        this._connections = [];
        this._dash = this._settings = null;
    }
}