/*global XMPP, app, me, client*/
"use strict";

var _ = require('underscore');
var async = require('async');
var uuid = require('node-uuid');
var HumanModel = require('human-model');
var Resources = require('./resources');
var Messages = require('./messages');
var Message = require('./message');
var crypto = XMPP.crypto;


module.exports = HumanModel.define({
    initialize: function (attrs) {
        if (attrs.jid) {
            this.id = attrs.jid;
        }
        this.setAvatar(attrs.avatarID);

        this.resources.bind('add remove reset change', this.onResourceChange, this);
    },
    type: 'contact',
    props: {
        id: ['string', true, false],
        avatarID: ['string', true, ''],
        groups: ['array', true, []],
        inRoster: ['bool', true, false],
        jid: ['string', true],
        name: ['string', true, ''],
        owner: ['string', true, ''],
        storageId: ['string', true, ''],
        subscription: ['string', true, 'none']
    },
    session: {
        activeContact: ['bool', true, false],
        avatar: 'string',
        chatState: ['string', true, 'gone'],
        idleSince: 'string',
        lastInteraction: 'date',
        lastSentMessage: 'object',
        lockedResource: 'string',
        offlineStatus: ['string', true, ''],
        show: ['string', true, 'offline'],
        status: ['string', true, ''],
        timezoneOffset: 'number',
        topResource: 'string',
        unreadCount: ['number', true, 0]
    },
    derived: {
        displayName: {
            deps: ['name', 'jid'],
            fn: function () {
                return this.name || this.jid;
            }
        },
        formattedTZO: {
            deps: ['timezoneOffset', 'displayName'],
            fn: function () {
                if (this.timezoneOffset !== undefined) {
                    var localTZO = (new Date()).getTimezoneOffset();
                    var diff = Math.abs(localTZO  % (24 * 60) - this.timezoneOffset % (24 * 60)) / 60;
                    if (diff === 0) {
                        return this.displayName + ' is in the same timezone as you';
                    }
                    var dir = (localTZO > this.timezoneOffset) ? 'ahead' : 'behind';
                    return this.displayName + ' is ' + diff + 'hrs ' + dir + ' you';
                } else {
                    return '';
                }
            }
        },
        hasUnread: {
            deps: ['unreadCount'],
            fn: function () {
                return this.unreadCount > 0;
            }
        }
    },
    collections: {
        resources: Resources,
        messages: Messages
    },
    setAvatar: function (id, type) {
        var self = this;

        if (!id) {
            var gID = crypto.createHash('md5').update(this.jid).digest('hex');
            self.avatar = 'https://gravatar.com/avatar/' + gID + '?s=30&d=mm';
            return;
        }

        app.storage.avatars.get(id, function (err, avatar) {
            if (err) {
                if (!type) {
                    // We can't find the ID, and we don't know the type, so fallback.
                    var gID = crypto.createHash('md5').update(self.jid).digest('hex');
                    self.avatar = 'https://gravatar.com/avatar/' + gID + '?s=30&d=mm';
                    return;
                }
                app.whenConnected(function () {
                    client.getAvatar(self.jid, id, function (err, resp) {
                        if (err) return;
                        resp = resp.toJSON();
                        var avatarData = resp.pubsub.retrieve.item.avatarData;
                        var dataURI = 'data:' + type + ';base64,' + avatarData;
                        app.storage.avatars.add({id: id, uri: dataURI});
                        self.set({
                            avatar: dataURI,
                            avatarID: id
                        });
                        self.save();
                    });
                });
            } else {
                self.set({
                    avatar: avatar.uri,
                    avatarID: avatar.id
                });
                self.save();
            }
        });
    },
    onLockedResourceChange: function () {
        var res = this.resources.get(this.lockedResource);
        if (res) {
            this.status = res.status;
            this.show = res.show || 'online';
            this.timezoneOffset = res.timezoneOffset;
            this.idleSince = res.idleSince;
        }
    },
    onResourceChange: function () {
        // Manually propagate change events for properties that
        // depend on the resources collection.
        this.resources.sort();

        var res = this.resources.first();
        if (res) {
            this.offlineStatus = '';
            this.topResource = res.id;
            if (!this.lockedResource) {
                this.status = res.status;
                this.show = res.show || 'online';
                this.timezoneOffset = res.timezoneOffset;
                this.idleSince = res.idleSince;
            }
        } else {
            this.topResource = undefined;
            this.chatState = 'gone';
            this.status = this.offlineStatus;
            this.show = 'offline';
            this.timezoneOffset = undefined;
            this.idleSince = undefined;
        }

        this.lockedResource = undefined;
    },
    addMessage: function (message, notify) {
        message.owner = me.jid.bare;

        if (notify && (!this.activeContact || (this.activeContact && !app.hasFocus)) && message.from.bare === this.jid) {
            this.unreadCount++;
            app.notifier.show({
                title: this.displayName,
                description: message.body,
                icon: this.avatar,
                onclick: _.bind(app.navigate, app, '/chat/' + this.jid)
            });
        }

        this.messages.add(message);

        message.save();

        var newInteraction = new Date(message.created);
        if (!this.lastInteraction || this.lastInteraction < newInteraction) {
            this.lastInteraction = newInteraction;
        }
    },
    fetchHistory: function () {
        var self = this;
        app.whenConnected(function () {
            var filter = {
                count: 20,
                before: true,
            };

            var lastMessage = self.messages.last();
            if (lastMessage && lastMessage.archivedId) {
                filter.after = lastMessage.archivedId;
            }

            client.getHistory({
                with: self.jid,
                start: self.lastInteraction,
                rsm: filter
            }, function (err, res) {
                if (err) return;

                var results = res.mamQuery.results || [];
                results.reverse();
                results.forEach(function (result) {
                    result = result.toJSON();
                    var msg = result.mam.forwarded.message;
                    
                    if (!msg.id) {
                        msg.id = uuid.v4();
                    }

                    if (!msg.delay) {
                        msg.delay = result.mam.forwarded.delay;
                    }

                    if (msg.replace) {
                        var original = self.messages.get(msg.replace);
                        // Drop the message if editing a previous, but
                        // keep it if it didn't actually change an
                        // existing message.
                        if (original && original.correct(msg)) return;
                    }


                    var message = new Message(msg);
                    message.archivedId = result.mam.id;

                    self.addMessage(message, false);
                });
            });
        });
    },
    save: function () {
        if (!this.inRoster) return;

        var data = {
            storageId: this.storageId,
            owner: this.owner,
            jid: this.jid,
            name: this.name,
            groups: this.groups,
            subscription: this.subscription,
            avatarID: this.avatarID
        };
        app.storage.roster.add(data);
    }
});
