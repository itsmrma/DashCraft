import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {Animations} from './Animations.js';
import {Autohide} from './Autohide.js';
import {Badges} from './Badges.js';
import {Blur} from './Blur.js';
import {Colors} from './Colors.js';
import {IconSize} from './IconSize.js';
import {Icons} from './Icons.js';
import {Menu} from './Menu.js';

import {Dash} from 'resource:///org/gnome/shell/ui/dash.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';

/* ----- Per-Dock Modules ----- */

export function createDockModules(dash, host, settings, isDesktop, openPreferences) {
    const colors = new Colors(dash, settings);
    const icons = new Icons(dash, settings);
    const badges = new Badges(dash, settings);
    const animations = new Animations(dash, isDesktop);
    const iconSize = new IconSize(dash, settings, isDesktop);
    const blur = new Blur(dash, settings);
    let autohide = null;
    const menu = new Menu(dash, openPreferences, () => autohide?.queueSync());
    autohide = new Autohide(host, dash, settings, isDesktop, () => menu.isOpen);
    return {
        autohide,
        destroy() {
            autohide.destroy();
            animations.destroy();
            badges.destroy();
            blur.destroy();
            colors.destroy();
            icons.destroy();
            iconSize.destroy();
            menu.destroy();
        },
    };
}

/* ----- Secondary Monitor Dock ----- */

export class Dock {
    constructor(settings, monitor, openPreferences) {
        this._settings = settings;
        this._monitor = monitor;
        this._connections = [];
        this._dash = new Dash();
        this._host = new St.Widget({
            name: 'dashcraft-host',
            layout_manager: new Clutter.BinLayout(),
        });
        Main.layoutManager.addChrome(this._host, {
            affectsStruts: false,
            trackFullscreen: true,
        });
        this._dash.x_align = Clutter.ActorAlign.CENTER;
        this._dash.y_align = Clutter.ActorAlign.END;
        this._dash.set_position(0, 0);
        this._host.add_child(this._dash);
        this._modules = createDockModules(this._dash, this._host, settings,
            () => true, openPreferences);
        this._connect(this._dash, 'notify::height', () => this._modules.autohide.queueSync());
        this._connect(this._dash.showAppsButton, 'notify::checked', button => {
            if (button.checked)
                Main.overview.show(ControlsState.APP_GRID);
        });
        this._connect(Main.overview, 'hiding', () => {
            this._dash.showAppsButton.checked = false;
        });
        this._host.set_position(monitor.x, monitor.y);
        this._host.set_size(monitor.width, monitor.height);
        this._dash.setMaxSize(monitor.width, Math.round(monitor.height * 0.16));
        this._modules.autohide.queueSync();
    }

    _connect(object, signal, callback) {
        this._connections.push([object, object.connect(signal, callback)]);
    }

    /* ----- Cleanup ----- */

    destroy() {
        for (const [object, id] of this._connections)
            object.disconnect(id);
        this._connections = [];
        this._modules.destroy();
        Main.layoutManager.removeChrome(this._host);
        this._host.remove_child(this._dash);
        this._dash.destroy();
        this._host.destroy();
        this._dash = this._host = this._modules = this._settings = this._monitor = null;
    }
}