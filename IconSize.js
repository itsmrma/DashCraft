import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DURATION = 200;

/* ----- Custom Icon Size ----- */

export class IconSize {
    constructor(dash, settings, isDesktop) {
        this._dash = dash;
        this._settings = settings;
        this._isDesktop = isDesktop;
        this._descriptor = Object.getOwnPropertyDescriptor(dash, '_adjustIconSize');
        this._original = dash._adjustIconSize;
        this._changedId = settings.connect('changed::icon-size', () => this._apply());
        dash._adjustIconSize = () => this._adjust();
        this._apply();
    }

    _apply() {
        this._dash._adjustIconSize();
    }

    _adjust() {
        const size = this._settings.get_int('icon-size');
        if (size <= 0 || !this._isDesktop()) {
            this._original.call(this._dash);
            return;
        }
        this._setSize(size);
    }

    _setSize(size) {
        const dash = this._dash;
        const iconChildren = dash._box.get_children().filter(actor =>
            actor.child && actor.child._delegate &&
            actor.child._delegate.icon && !actor.animatingOut);
        iconChildren.push(dash._showAppsIcon);

        if (dash._maxWidth !== -1 && iconChildren.length > 0) {
            const themeNode = dash.get_theme_node();
            const maxAllocation = new Clutter.ActorBox({
                x1: 0,
                y1: 0,
                x2: dash._maxWidth,
                y2: 42,
            });
            const maxContent = themeNode.get_content_box(maxAllocation);
            let availWidth = maxContent.x2 - maxContent.x1;
            const spacing = themeNode.get_length('spacing');
            const firstButton = iconChildren[0].child;
            const firstIcon = firstButton._delegate.icon;
            firstIcon.icon.ensure_style();
            const [, , iconWidth] = firstIcon.icon.get_preferred_size();
            const [, , buttonWidth] = firstButton.get_preferred_size();
            availWidth -= iconChildren.length * (buttonWidth - iconWidth) +
                (iconChildren.length - 1) * spacing;
            const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const maxFit = Math.floor(availWidth / iconChildren.length / scaleFactor);
            if (maxFit >= 16)
                size = Math.min(size, maxFit);
        }

        if (dash.iconSize === size)
            return;

        const oldIconSize = dash.iconSize;
        dash.iconSize = size;
        dash.emit('icon-size-changed');

        const animate = dash.mapped && dash._shownInitially &&
            !Main.overview.animationInProgress;
        const scale = oldIconSize / size;
        for (const item of iconChildren) {
            const icon = item.child._delegate.icon;
            icon.setIconSize(size);
            if (!animate)
                continue;
            const [targetWidth, targetHeight] = icon.icon.get_size();
            icon.icon.set_size(icon.icon.width * scale, icon.icon.height * scale);
            icon.icon.ease({
                width: targetWidth,
                height: targetHeight,
                duration: DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        if (dash._separator) {
            if (animate) {
                dash._separator.ease({
                    height: size,
                    duration: DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                dash._separator.height = size;
            }
        }
    }

    /* ----- Cleanup ----- */

    destroy() {
        this._settings.disconnect(this._changedId);
        if (this._descriptor)
            Object.defineProperty(this._dash, '_adjustIconSize', this._descriptor);
        else
            delete this._dash._adjustIconSize;
        if (this._dash._maxWidth !== -1)
            this._dash._adjustIconSize();
        this._dash = this._settings = this._original = this._descriptor = this._isDesktop = null;
    }
}