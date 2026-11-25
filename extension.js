import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {createDockModules, Dock} from './Dock.js';
import {Panel} from './Panel.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';

/* ----- Overview Slot ----- */

const DashSlot = GObject.registerClass(class DashCraftSlot extends St.Widget {
    _init(dash) {
        super._init();
        this._dash = dash;
    }

    setMaxSize() {}

    vfunc_get_preferred_width(forHeight) {
        return this._dash.get_preferred_width(forHeight);
    }

    vfunc_get_preferred_height(forWidth) {
        return this._dash.get_preferred_height(forWidth);
    }
});

/* ----- Extension Lifecycle ----- */

export default class DashCraft extends Extension {
    enable() {
        try {
            this._enable();
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    _enable() {
        this._connections = [];
        this._settings = this.getSettings();
        this._dash = Main.overview.dash;
        this._parent = this._dash.get_parent();
        this._layout = this._parent.layout_manager;
        this._index = this._parent.get_children().indexOf(this._dash);
        this._alignment = this._dash.x_align;
        this._yAlignment = this._dash.y_align;
        this._slot = new DashSlot(this._dash);
        this._desktop = false;
        this._secondaryDocks = new Map();
        this._host = new St.Widget({
            name: 'dashcraft-host',
            layout_manager: new Clutter.BinLayout(),
        });
        Main.layoutManager.addChrome(this._host, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        this._connect(this._settings, 'changed::show-dock', () => this._syncLocation());
        this._connect(this._settings, 'changed::all-monitors', () => this._syncMonitors());
        this._connect(Main.layoutManager, 'startup-complete', () => this._syncLocation());
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            this._restoreDash();
            this._destroySecondaryDocks();
            this._syncLocation();
        });
        this._connect(this._dash, 'notify::height', () => this._modules?.autohide.queueSync());
        this._connect(this._dash.showAppsButton, 'notify::checked', button => {
            if (this._desktop && button.checked)
                Main.overview.show(ControlsState.APP_GRID);
        });
        this._panel = new Panel(this._settings);
        this._modules = createDockModules(this._dash, this._host, this._settings,
            () => this._desktop, () => this.openPreferences());
        this._syncLocation();
    }

    _connect(object, signal, callback) {
        this._connections.push([object, object.connect(signal, callback)]);
    }

    /* ----- Dock Placement ----- */

    _syncLocation() {
        if (!this._settings.get_boolean('show-dock') ||
            Main.layoutManager._startingUp || !Main.layoutManager.primaryMonitor) {
            this._restoreDash();
            this._destroySecondaryDocks();
            return;
        }
        if (!this._desktop) {
            this._parent.remove_child(this._dash);
            this._parent.insert_child_at_index(this._slot, this._index);
            this._layout._dash = this._slot;
            this._dash.x_align = Clutter.ActorAlign.CENTER;
            this._dash.y_align = Clutter.ActorAlign.END;
            this._dash.set_position(0, 0);
            this._host.add_child(this._dash);
            this._desktop = true;
            const monitor = Main.layoutManager.primaryMonitor;
            this._host.set_position(monitor.x, monitor.y);
            this._host.set_size(monitor.width, monitor.height);
            this._dash.setMaxSize(monitor.width, Math.round(monitor.height * 0.16));
        }
        this._syncMonitors();
        this._modules?.autohide.queueSync();
    }

    _restoreDash() {
        if (!this._desktop)
            return;
        this._desktop = false;
        this._modules?.autohide.sync();
        this._host.remove_child(this._dash);
        this._parent.remove_child(this._slot);
        this._layout._dash = this._dash;
        this._dash.x_align = this._alignment;
        this._dash.y_align = this._yAlignment;
        this._dash.set_position(0, 0);
        this._parent.insert_child_at_index(this._dash, this._index);
        this._parent.queue_relayout();
    }

    /* ----- Secondary Monitors ----- */

    _syncMonitors() {
        const want = this._settings.get_boolean('show-dock') &&
            this._settings.get_boolean('all-monitors') &&
            !Main.layoutManager._startingUp && !!Main.layoutManager.primaryMonitor;
        const primaryIndex = Main.layoutManager.primaryIndex;
        const desired = want
            ? Main.layoutManager.monitors.filter(m => m.index !== primaryIndex)
            : [];
        const desiredIndices = new Set(desired.map(m => m.index));
        for (const [index, dock] of [...this._secondaryDocks]) {
            if (!desiredIndices.has(index)) {
                dock.destroy();
                this._secondaryDocks.delete(index);
            }
        }
        for (const monitor of desired) {
            if (!this._secondaryDocks.has(monitor.index)) {
                this._secondaryDocks.set(monitor.index,
                    new Dock(this._settings, monitor, () => this.openPreferences()));
            }
        }
    }

    _destroySecondaryDocks() {
        for (const dock of this._secondaryDocks.values())
            dock.destroy();
        this._secondaryDocks.clear();
    }

    /* ----- Cleanup ----- */

    disable() {
        this._destroySecondaryDocks();
        this._modules?.destroy();
        this._modules = null;
        this._panel?.destroy();
        for (const [object, id] of this._connections ?? [])
            object.disconnect(id);
        this._connections = [];
        this._restoreDash();
        if (this._host) {
            Main.layoutManager.removeChrome(this._host);
            this._host.destroy();
        }
        this._slot?.destroy();
        this._host = this._slot = this._layout = this._parent = this._dash = null;
        this._settings = this._panel = null;
    }
}