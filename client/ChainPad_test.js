/*
 * Copyright 2014 XWiki SAS
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
var ChainPad = require('./ChainPad');
var Common = require('./Common');
var Operation = require('./Operation');
var Sha = require('./SHA256');
var nThen = require('nthen');

ChainPad.Common.TESTING = true;

var startup = function (callback) {
    var rt = ChainPad.create({
        userName: 'x',
        initialState: 'abc'
    });
    rt.abort();
    callback();
};

var runOperation = function (realtimeFacade, op) {
    realtimeFacade.change(op.offset, op.toRemove, op.toInsert);
};

var insert = function (doc, offset, chars) {
    return doc.substring(0,offset) + chars + doc.substring(offset);
};

var remove = function (doc, offset, count) {
    return doc.substring(0,offset) + doc.substring(offset+count);
};

var registerNode = function (name, initialDoc, conf) {
    conf = conf || {};
    conf.userName = conf.userName || name;
    conf.initialState = initialDoc;
    var rt = ChainPad.create(conf);
    //rt.change(0, 0, initialDoc);

    var handlers = [];
    rt.onMessage(function (msg, cb) {
        setTimeout(function () {
            handlers.forEach(function (handler) { handler(msg, cb); });
        });
    });
    rt.onMessage = function (handler) {
        handlers.push(handler);
    }

    rt.doc = initialDoc;

    rt.onPatch(function () { rt.doc = rt.getUserDoc() });
    return rt;
};

var editing = function (callback) {
    var doc = '';
    var rt = registerNode('editing()', '');
    var messages = 0;
    rt.onMessage(function (msg, cb) {
        messages++;
        //rt.message(msg);
        cb();
    });
    rt.start();

    var i = 0;
    var to = setInterval(function () {
        if (i++ > 10) {
            clearTimeout(to);
            for (var j = 0; j < 100; j++) {
                var m = messages;
                rt.sync();
                if (m === messages) {
                    rt.abort();
                    callback();
                    return;
                }
            }
            throw new Error();
        }
        // fire off another operation
        var op = Operation.random(doc.length);
        doc = Operation.apply(op, doc);
        runOperation(rt, op);
        rt.sync();
    },1);

};

var fakeSetTimeout = function (func, time) {
    var i = time;
    var tick = function () { if (i-- <= 0) { func() } else { setTimeout(tick); } };
    setTimeout(tick);
};

var twoClientsCycle = function (callback, origDocA, origDocB) {
    var rtA = registerNode('twoClients(rtA)', origDocA);
    var rtB = registerNode('twoClients(rtB)', origDocB);
    rtA.queue = [];
    rtB.queue = [];
    var messages = 0;

    var onMsg = function (rt, msg, cb) {
        messages++;
        var destRt = (rt === rtA) ? rtB : rtA;
        fakeSetTimeout(function () {
            messages--;
            destRt.queue.push(msg);
            fakeSetTimeout(function () {
                destRt.message(destRt.queue.shift());
                cb();
            }, Math.random() * 100);
        }, Math.random() * 100);
    };
    [rtA, rtB].forEach(function (rt) {
        rt.onMessage(function (msg, cb) { onMsg(rt, msg, cb) });
        rt.start();
    });
    //[rtA, rtB].forEach(function (rt) { rt.start(); });

    var i = 0;
    var to = setInterval(function () {
        if (i++ > 100) {
            clearTimeout(to);
            var j = 0;
            var flushCounter = 0;
            var again = function () {
                if (++j > 10000) { throw new Error("never synced"); }
                rtA.sync();
                rtB.sync();
                if (messages === 0 && rtA.queue.length === 0 && rtB.queue.length === 0 && flushCounter++ > 100) {
                    console.log(rtA.getUserDoc());
                    console.log(rtB.getUserDoc());
                    Common.assert(rtA.doc === rtB.doc);
                    rtA.abort();
                    rtB.abort();
                    callback();
                    return;
                } else {
                    setTimeout(again);
                }
            };
            again();
        }

//console.log(JSON.stringify([rtA.doc, rtB.doc]));

        var rt = (Math.random() > 0.5) ? rtA : rtB;

        var op = Operation.random(rt.doc.length);
        rt.doc = Operation.apply(op, rt.doc);
        runOperation(rt, op);

        if (Math.random() > 0.8) {
            rt.sync();
        }
    },1);

};

var twoClients = function (cycles, callback) {
    var i = 0;
    var again = function () {
        if (++i >= cycles) { again = callback; }
        var docA = Common.randomASCII(Math.floor(Math.random()*20));
        var docB = Common.randomASCII(Math.floor(Math.random()*20));
        twoClientsCycle(again, docA, docB);
    };
    again();
};

var syncCycle = function (messages, finalDoc, name, callback) {
    var rt = registerNode(name, '');
    for (var i = 0; i < messages.length; i++) {
        rt.message(messages[i]);
    }
    setTimeout(function () {
        Common.assert(rt.doc === finalDoc);
        rt.abort();
        callback();
    });
};

var outOfOrderSync = function (callback) {
    var messages = [];
    var rtA = registerNode('outOfOrderSync()', '', { checkpointInterval: 1000 });
    rtA.onMessage(function (msg, cb) {
        setTimeout(cb);
        messages.push(msg);
    });
    var i = 0;
    rtA.start();

    var finish = function () {
        rtA.abort();
        var i = 0;
        var cycle = function () {
            if (i++ > 10) {
                callback();
                return;
            }
            // first sync is in order
            syncCycle(messages, rtA.doc, 'outOfOrderSync(rt'+i+')', function () {
                for (var j = 0; j < messages.length; j++) {
                    var k = Math.floor(Math.random() * messages.length);
                    var m = messages[k];
                    messages[k] = messages[j];
                    messages[j] = m;
                }
                cycle();
            });
        };
        cycle();
    };

    var again = function () {
        setTimeout( (i++ < 150) ? again : finish );
        if (i < 100) {
            var op = Operation.random(rtA.doc.length);
            rtA.doc = Operation.apply(op, rtA.doc);
            runOperation(rtA, op);
        }
        rtA.sync();
    };
    again();
};

var checkVersionInChain = function (callback) {
    var doc = '';
// create a chainpad
    var rt = registerNode('checkVersionInChain()', '', { checkpointInterval: 1000 });
    var messages = 0;
    rt.onMessage(function (msg, cb) {
        messages++;
        cb(); // must be sync because of the setInterval below
    });
    rt.start();

    var i = 0;
    var oldUserDoc;
    var to = setInterval(function () {
// on the 51st change, grab the doc
        if (i === 50) {
            oldAuthDoc = rt.getAuthDoc();
        }
// on the 100th random change, check whether the 50th existed before
        if (i++ > 100) {
            clearTimeout(to);
            Common.assert(rt.getDepthOfState(oldAuthDoc) !== -1);
            Common.assert(rt.getDepthOfState(rt.getAuthDoc()) !== -1)
            rt.abort();
            callback();
            return;
        }

        // fire off another operation
        var op = Operation.random(doc.length);
        doc = Operation.apply(op, doc);
        runOperation(rt, op);
        rt.sync();
    },1);

};

var whichStateIsDeeper = function (callback) {
// create a chainpad
    var rt = registerNode('whichStateIsDeeper()', '', { checkpointInterval: 1000 });
    var messages = 0;
    rt.onMessage(function (msg, cb) {
        messages++;
        cb();
    });
    rt.start();

    var doc = '',
        docO = doc,
        docA,
        docB;

    var i = 0;

    var to = setInterval(function () {
        if (i === 25) {
            // grab docO
            docO = rt.getAuthDoc();
        } else if (i === 50) {
            // grab docA
            docA = rt.getAuthDoc();
            console.log("Got Document A");
            console.log(docA);

            Common.assert(rt.getDepthOfState(docA) === 0);
            Common.assert(rt.getDepthOfState(docO) === 25);
        } else if (i === 75) {
            // grab docB
            docB = rt.getAuthDoc();
            console.log("Got Document B");
            console.log(docB);

            // state assertions
            Common.assert(rt.getDepthOfState(docB) === 0);
            Common.assert(rt.getDepthOfState(docA) === 25);
            Common.assert(rt.getDepthOfState(docO) === 50);
        } else if (i >= 100) {
            console.log("Completed");
            // finish
            clearTimeout(to);

            Common.assert(rt.getDepthOfState(docB) === 25);
            Common.assert(rt.getDepthOfState(docA) === 50);
            Common.assert(rt.getDepthOfState(docO) === 75);

            rt.abort();
            callback();
            return;
        }

        i++;
        var op;
        do {
            op = Operation.random(doc.length);
             // we can't have the same state multiple times for this test.
        } while (op.toInsert.length <= op.toRemove);
        doc = Operation.apply(op,doc);
        runOperation(rt, op);
        rt.sync();
    },1);
};

var checkpointOT = function (callback) {
    var rtA = registerNode('checkpointOT(rtA)', '', { checkpointInterval: 10 });
    var rtB = registerNode('checkpointOT(rtB)', '', { checkpointInterval: 10 });
    rtA.queue = [];
    rtB.queue = [];
    var messages = 0;
    var syncing = 0;

    var onMsg = function (rt, msg, cb) {
        if (syncing) {
            setTimeout(function () { onMsg(rt, msg, cb); });
            return;
        }
        messages++;
        var destRt = (rt === rtA) ? rtB : rtA;
        syncing++;
        setTimeout(function () {
            messages--;
            destRt.queue.push(msg);
            setTimeout(function () {
                destRt.message(destRt.queue.shift());
                syncing--;
                cb();
            });
        });
    };
    [rtA, rtB].forEach(function (rt) {
        rt.onMessage(function (msg, cb) { onMsg(rt, msg, cb) });
        rt.start();
    });

    var i = 0;
    var to = setInterval(function () {
        if (syncing) { return; }
        i++;
        if (i < 20) {
            var op = Operation.random(rtA.doc.length);
            rtA.doc = Operation.apply(op, rtA.doc);
            runOperation(rtA, op);
        } else if (i === 25) {
            //console.log(rtA.getUserDoc() + ' ==x= ' + rtB.getUserDoc());
            Common.assert(rtA.getUserDoc() === rtB.getAuthDoc());
            Common.assert(rtA.getUserDoc() === rtB.getUserDoc());
            Common.assert(rtA.getAuthDoc() === rtB.getAuthDoc());
            var opA = Operation.create(0, 0, 'A');
            var opB = Operation.create(1, 0, 'B');
            runOperation(rtA, opA);
            runOperation(rtB, opB);
        } else if (i > 35) {
            console.log("rtA authDoc " + rtA.getAuthDoc());
            console.log("rtB authDoc " + rtB.getAuthDoc());
            Common.assert(rtA.getUserDoc() === rtB.getUserDoc());
            Common.assert(rtA.getAuthDoc() === rtB.getAuthDoc());
            Common.assert(rtA.getAuthDoc()[0] === 'A');
            Common.assert(rtA.getAuthDoc()[2] === 'B');

            clearTimeout(to);
            rtA.abort();
            rtB.abort();
            callback();
            return;
        }

        rtA.sync();
        rtB.sync();
        //console.log(rtA.getUserDoc() + ' === ' + rtB.getUserDoc());
    });

};

var getAuthBlock = function (callback) {
    var doc = '';
// create a chainpad
    var rt = registerNode('getAuthBlock()', '', { checkpointInterval: 1000 });
    var messages = 0;
    rt.onMessage(function (msg, cb) {
        messages++;
        cb(); // must be sync because of the setInterval below
    });
    rt.start();

    var i = 0;
    var oldUserDoc;
    var to = setInterval(function () {
        // on the 51st change, grab the block
        if (i === 50) {
            oldAuthBlock = rt.getAuthBlock();
            oldAuthDoc = rt.getAuthDoc();
            Common.assert(oldAuthBlock.getContent().doc === oldAuthDoc);
        }
        // on the 100th random change, check if getting the state at oldAuthBlock works...
        if (i++ > 100) {
            clearTimeout(to);
            Common.assert(oldAuthBlock.getContent().doc === oldAuthDoc);
            Common.assert(oldAuthBlock.equals(rt.getBlockForHash(oldAuthBlock.hashOf)));
            rt.abort();
            callback();
            return;
        }

        // fire off another operation
        var op = Operation.random(doc.length);
        doc = Operation.apply(op, doc);
        runOperation(rt, op);
        rt.sync();
    },1);
};

var main = module.exports.main = function (cycles, callback) {
    nThen(function (waitFor) {
        startup(waitFor());
    }).nThen(function (waitFor) {
        editing(waitFor());
    }).nThen(function (waitFor) {
        twoClients(cycles, waitFor());
    }).nThen(function (waitFor) {
        outOfOrderSync(waitFor());
    }).nThen(function (waitFor) {
        checkVersionInChain(waitFor());
    }).nThen(function (waitFor) {
        whichStateIsDeeper(waitFor());
    }).nThen(function (waitFor) {
        checkpointOT(waitFor());
    }).nThen(function (waitFor) {
        getAuthBlock(waitFor());
    }).nThen(callback);
};
