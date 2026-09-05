/* ============================================================
 * sequencer.js — 录音回放 + 自动演奏
 *
 *  Recorder   ：记录 noteOn/noteOff/踏板事件，可回放。
 *  Sequencer  ：前瞻式调度器，把事件序列按时间轴回调出去。
 *  AutoPlayer ：自动播放内置乐曲；「按键跟随（假弹）」模式下，
 *               用户随便敲键盘，乐曲就按敲击的节奏一步步推进。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- 通用调度器 ---------------- */

  function Sequencer() {
    this.events = [];
    this.idx = 0;
    this.startTs = 0;
    this.timer = null;
    this.playing = false;
    this.onEvent = null;   // (event) => void
    this.onEnd = null;
  }

  Sequencer.prototype.start = function (events, onEvent, onEnd) {
    this.stop();
    this.events = events.slice().sort(function (a, b) { return a.t - b.t; });
    this.idx = 0;
    this.onEvent = onEvent;
    this.onEnd = onEnd;
    this.playing = true;
    this.startTs = performance.now();
    var self = this;
    this.timer = setInterval(function () { self._tick(); }, 30);
    this._tick();
  };

  Sequencer.prototype._tick = function () {
    if (!this.playing) return;
    var elapsed = performance.now() - this.startTs;
    var lookahead = 60;
    while (this.idx < this.events.length && this.events[this.idx].t <= elapsed + lookahead) {
      var ev = this.events[this.idx++];
      var delay = Math.max(0, ev.t - elapsed);
      this._fire(ev, delay);
    }
    if (this.idx >= this.events.length) {
      var end = this.onEnd;
      this.stop();
      if (end) setTimeout(end, 80);
    }
  };

  Sequencer.prototype._fire = function (ev, delay) {
    if (delay <= 1) { this.onEvent && this.onEvent(ev); return; }
    setTimeout(function () { this.onEvent && this.onEvent(ev); }.bind(this), delay);
  };

  Sequencer.prototype.progress = function () {
    if (!this.events.length) return 0;
    return this.idx / this.events.length;
  };

  Sequencer.prototype.stop = function () {
    this.playing = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  };

  /* ---------------- 录音 ---------------- */

  var Recorder = {
    events: [],
    recording: false,
    playing: false,
    startTs: 0,
    seq: new Sequencer(),

    start: function () {
      this.events = [];
      this.recording = true;
      this.startTs = performance.now();
    },

    stop: function () {
      this.recording = false;
    },

    duration: function () {
      return this.events.length ? this.events[this.events.length - 1].t : 0;
    },

    noteCount: function () {
      var n = 0;
      for (var i = 0; i < this.events.length; i++) if (this.events[i].k === 'on') n++;
      return n;
    },

    capture: function (kind, midi, vel) {
      if (!this.recording) return;
      this.events.push({ t: Math.round(performance.now() - this.startTs), k: kind, n: midi, v: vel });
    },

    play: function (onNoteOn, onNoteOff, onPedal, onEnd) {
      if (!this.events.length) return false;
      this.playing = true;
      var self = this;
      this.seq.start(this.events, function (ev) {
        if (ev.k === 'on') onNoteOn(ev.n, ev.v);
        else if (ev.k === 'off') onNoteOff(ev.n);
        else if (ev.k === 'ped') onPedal(ev.v);
      }, function () {
        self.playing = false;
        onEnd && onEnd();
      });
      return true;
    },

    stopPlay: function () {
      this.seq.stop();
      this.playing = false;
    },

    clear: function () {
      this.events = [];
      this.recording = false;
    }
  };

  /* ---------------- 自动演奏 ---------------- */

  var AutoPlayer = {
    playing: false,
    mode: 'auto',        // 'auto' | 'follow'
    song: null,
    entries: [],
    pointer: 0,
    seq: new Sequencer(),
    pendingOffs: [],

    start: function (song, mode, hooks) {
      this.stop();
      this.song = song;
      this.mode = mode;
      this.playing = true;
      this.hooks = hooks || {};

      if (mode === 'auto') {
        // 展开为 on/off 事件序列
        var seqEvents = [];
        for (var i = 0; i < song.events.length; i++) {
          var e = song.events[i];
          for (var j = 0; j < e.notes.length; j++) {
            seqEvents.push({ t: e.t, k: 'on', n: e.notes[j], v: 0.85 });
            seqEvents.push({ t: e.t + e.d, k: 'off', n: e.notes[j] });
          }
        }
        this.seq.start(seqEvents, function (ev) {
          if (ev.k === 'on') hooks.noteOn(ev.n, ev.v);
          else hooks.noteOff(ev.n);
        }, function () {
          hooks.onEnd && hooks.onEnd();
        });
        this.total = seqEvents.length;
      } else {
        this.entries = song.events.slice();
        this.pointer = 0;
        this.total = this.entries.length;
      }
      return true;
    },

    /** 跟随模式：用户按键推进乐曲；返回 true 表示该按键被乐曲“接管” */
    handleUserKey: function (midi) {
      if (!this.playing || this.mode !== 'follow') return false;
      if (this.pointer >= this.entries.length) return false;

      var e = this.entries[this.pointer++];
      var hooks = this.hooks;
      var self = this;
      var offs = [];
      for (var i = 0; i < e.notes.length; i++) {
        hooks.noteOn(e.notes[i], 0.85);
        (function (n, d) {
          offs.push(setTimeout(function () { hooks.noteOff(n); }, d));
        })(e.notes[i], e.d);
      }
      this.pendingOffs = this.pendingOffs.concat(offs);
      if (this.pointer >= this.entries.length) {
        setTimeout(function () {
          if (self.playing) {
            self.playing = false;
            hooks.onEnd && hooks.onEnd();
          }
        }, e.d + 300);
      }
      return true;
    },

    progress: function () {
      if (this.mode === 'auto') return this.seq.progress();
      return this.total ? this.pointer / this.total : 0;
    },

    stop: function () {
      this.playing = false;
      this.seq.stop();
      for (var i = 0; i < this.pendingOffs.length; i++) clearTimeout(this.pendingOffs[i]);
      this.pendingOffs = [];
      this.pointer = 0;
    }
  };

  window.Sequencer = Sequencer;
  window.Recorder = Recorder;
  window.AutoPlayer = AutoPlayer;
})();
