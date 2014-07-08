const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Util = imports.misc.util;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const CheckBox = imports.ui.checkBox.CheckBox;

const Clipboard = St.Clipboard.get_default();
const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;
const Prefs = Me.imports.prefs;
const prettyPrint = Convenience.dbPrintObj;
const writeRegistry = Convenience.writeRegistry;
const readRegistry = Convenience.readRegistry;

let TIMEOUT_MS           = 1000;
let MAX_REGISTRY_LENGTH  = 15;
let MAX_ENTRY_LENGTH     = 50;
let DELETE_ENABLED       = true;

let _clipboardTimeoutId = null;
const ClipboardIndicator = Lang.Class({
        Name: 'ClipboardIndicator',
        Extends: PanelMenu.Button,

        clipItemsRadioGroup: [],

        destroy: function () {
            // Disconnect the settings event
            this._settings.disconnect(this._settingsChangedId);

            // Call parent
            this.parent();
        },

        _init: function() {
            this.parent(0.0, "ClipboardIndicator");
            let hbox = new St.BoxLayout({ style_class: 'panel-status-menu-box clipboard-indicator-hbox' });
            let icon = new St.Icon({ icon_name: 'edit-cut-symbolic', //'mail-attachment-symbolic',
                                     style_class: 'system-status-icon clipboard-indicator-icon' });

            hbox.add_child(icon);
            this.actor.add_child(hbox);

            this._loadSettings();
            this._buildMenu();
            this._setupTimeout();
        },

        _buildMenu: function () {
            let that = this;
            this._getCache(function (clipHistory) {
                let lastIdx = clipHistory.length - 1;
                let clipItemsArr = that.clipItemsRadioGroup;

                // Create menu section for items
                that.historySection = new PopupMenu.PopupMenuSection();
                that.menu.addMenuItem(that.historySection);

                // Add cached items
                clipHistory.forEach(function (buffer) {
                    that._addEntry(buffer);
                });

                // Add separator
                that.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                // Add 'Clear' button which removes all items from cache
                let clearMenuItem = new PopupMenu.PopupMenuItem('Clear History');
                that.menu.addMenuItem(clearMenuItem);
                clearMenuItem.actor.connect('button-press-event', Lang.bind(that, that._removeAll));

                // Add 'Settings' menu item to open settings
                let settingsMenuItem = new PopupMenu.PopupMenuItem('Settings');
                that.menu.addMenuItem(settingsMenuItem);
                settingsMenuItem.actor.connect('button-press-event', Lang.bind(that, that._openSettings));

                if (lastIdx >= 0) {
                    that._selectMenuItem(clipItemsArr[lastIdx]);
                }
            });
        },

        _setEntryLabel: function (menuItem) {
            let buffer     = menuItem.clipContents,
                shortened  = buffer.substr(0,MAX_ENTRY_LENGTH).replace(/\s+/g, ' ');

            if (buffer.length > MAX_ENTRY_LENGTH)
                shortened += '...';

            menuItem.label.set_text(shortened);
        },

        _addEntry: function (buffer, autoSelect, autoSetClip) {
            let menuItem = new PopupMenu.PopupMenuItem('');

            menuItem.clipContents = buffer;
            menuItem.radioGroup = this.clipItemsRadioGroup;
            menuItem.buttonPressId = menuItem.actor.connect('button-press-event',
                                        Lang.bind(menuItem, this._onMenuItemSelected));

            this._setEntryLabel(menuItem);
            this.clipItemsRadioGroup.push(menuItem);

            let icon = new St.Icon({
                icon_name: 'edit-delete-symbolic', //'mail-attachment-symbolic',
                style_class: 'system-status-icon'
            });
            let icoBtn = new St.Button({
                x_fill: true,
                can_focus: true,
                child: icon
            });
            icoBtn.set_x_align(Clutter.ActorAlign.END);
            icoBtn.set_x_expand(true);
            icoBtn.set_y_expand(true);

            menuItem.actor.add_child(icoBtn);
            menuItem.icoBtn = icoBtn;
            menuItem.deletePressId = icoBtn.connect('button-press-event',
                Lang.bind(this, function () {
                    this._removeEntry(menuItem);
                }));

            this.historySection.addMenuItem(menuItem);
            if (autoSelect === true) this._selectMenuItem(menuItem, autoSetClip);
            this._updateCache();
        },

        _removeAll: function () {
            let that = this;
            // We can't actually remove all items, because the clipboard still
            // has data that will be re-captured on next refresh, so we remove
            // all except the currently selected item
            that.historySection._getMenuItems().forEach(function (mItem) {
                if (!mItem.currentlySelected) {
                    let idx = that.clipItemsRadioGroup.indexOf(mItem);
                    mItem.destroy();
                    that.clipItemsRadioGroup.splice(idx,1);
                }
            });
            that._updateCache();
        },

        _removeEntry: function (menuItem) {
            let itemIdx = this.clipItemsRadioGroup.indexOf(menuItem);

            menuItem.destroy();
            this.clipItemsRadioGroup.splice(itemIdx,1);
            this._updateCache();
        },

        _removeOldestEntries: function () {
            let that = this;
            while (that.clipItemsRadioGroup.length > MAX_REGISTRY_LENGTH) {
                let oldest = that.clipItemsRadioGroup.shift();
                oldest.actor.disconnect(oldest.buttonPressId);
                oldest.destroy();
            }

            that._updateCache();
        },

        _onMenuItemSelected: function (autoSet) {
            var that = this;
            that.radioGroup.forEach(function (menuItem) {
                let clipContents = that.clipContents;

                if (menuItem === that && clipContents) {
                    that.setOrnament(PopupMenu.Ornament.DOT);
                    that.icoBtn.visible = false;
                    that.currentlySelected = true;
                    if (autoSet !== false)
                        Clipboard.set_text(CLIPBOARD_TYPE, clipContents);
                }
                else {
                    menuItem.icoBtn.visible = true;
                    menuItem.setOrnament(PopupMenu.Ornament.NONE);
                    menuItem.currentlySelected = false;
                }
            });
        },

        _selectMenuItem: function (menuItem, autoSet) {
            let fn = Lang.bind(menuItem, this._onMenuItemSelected);
            fn(autoSet);
        },

        _getCache: function (cb) {
            return readRegistry(cb);
        },

        _updateCache: function () {
            writeRegistry(this.clipItemsRadioGroup.map(function (menuItem) {
                return menuItem.clipContents;
            }));
        },

        _refreshIndicator: function () {
            let that = this;
            Clipboard.get_text(CLIPBOARD_TYPE, function (clipBoard, text) {
                let registry = that.clipItemsRadioGroup.map(function (menuItem) {
                    return menuItem.clipContents;
                });
                if (text && registry.indexOf(text) < 0) {
                    that._addEntry(text, true, false);
                    that._removeOldestEntries();
                }
            });
        },

        _setupTimeout: function (recurse) {
            let that = this;
            recurse = typeof recurse === 'boolean' ? recurse : true;

            _clipboardTimeoutId = Mainloop.timeout_add(TIMEOUT_MS, function () {
                that._refreshIndicator();
                if (recurse) that._setupTimeout();
            });
        },

        _openSettings: function () {
            Util.spawn([
                "gnome-shell-extension-prefs",
                Me.uuid
            ]);
        },

        _loadSettings: function () {
            this._settings = Prefs.SettingsSchema;
            this._settingsChangedId = this._settings.connect('changed',
                                        Lang.bind(this, this._onSettingsChange));
            this._fetchSettings();
        },

        _fetchSettings: function () {
            TIMEOUT_MS           = this._settings.get_int(Prefs.Fields.INTERVAL);
            MAX_REGISTRY_LENGTH  = this._settings.get_int(Prefs.Fields.HISTORY_SIZE);
            MAX_ENTRY_LENGTH     = this._settings.get_int(Prefs.Fields.PREVIEW_SIZE);
            DELETE_ENABLED       = this._settings.get_boolean(Prefs.Fields.DELETE);
        },

        _onSettingsChange: function () {
            var that = this;

            // Load the settings into variables
            that._fetchSettings();

            // Remove old entries in case the registry size changed
            that._removeOldestEntries();

            // Re-set menu-items lables in case preview size changed
            that.historySection._getMenuItems().forEach(function (mItem) {
                that._setEntryLabel(mItem);
            });
        }
    });


function init () {

}

let clipboardIndicator;
function enable () {
    clipboardIndicator = new ClipboardIndicator();
    Main.panel.addToStatusArea('clipboardIndicator', clipboardIndicator, 1);
}

function disable () {
    clipboardIndicator.destroy();
    if (_clipboardTimeoutId) Mainloop.source_remove(_clipboardTimeoutId);
}
