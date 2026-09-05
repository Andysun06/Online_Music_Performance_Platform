/* ============================================================
 * audio-engine.js — Web Audio 演奏引擎
 *
 * 设计要点：
 *  - 复音：每个音符独立 BufferSource + 包络，互不打断，可叠奏（连奏不炸不卡）。
 *  - 同音重击：旧声道快速自然衰减（模拟真钢琴止音槌回位）。
 *  - 延音踏板：松键后声音保持，抬踏板统一释放，且支持半踏板式的自然衰减。
 *  - 主链：voiceBus → (干声 + 卷积混响) → 压缩器 → 主音量 → 输出，防止爆音。
 *  - 定位：低音略偏左、高音略偏右，模拟真实钢琴琴体宽度。
 * ============================================================ */
(function () {
  'use strict';

  function AudioEngine() {
    this.ctx = null;
    this.voices = new Map();      // midi -> [voice]
    this.sustainedNotes = new Set();
    this.pedalDown = false;
    this.timbre = { id: 'grand', map: null, cfg: SoundfontLoader.timbreById('grand') };
    this.activeVoices = [];
    this.maxVoices = 52;
    this.onVoiceStart = null;     // (midi) => void，可留给可视化
  }

  AudioEngine.prototype.ensureStarted = function () {
    if (!this.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this._buildGraph();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  };

  AudioEngine.prototype._buildGraph = function () {
    var c = this.ctx;

    this.bus = c.createGain();
    this.dry = c.createGain();
    this.wet = c.createGain();
    this.conv = c.createConvolver();
    this.conv.buffer = this._makeImpulseResponse(2.9, 2.4);

    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 26;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.22;

    this.master = c.createGain();
    this.master.gain.value = 0.8;

    this.bus.connect(this.dry);
    this.dry.connect(this.comp);
    this.bus.connect(this.conv);
    this.conv.connect(this.wet);
    this.wet.connect(this.comp);
    this.comp.connect(this.master);
    this.master.connect(c.destination);

    this.setReverb(0.25);
  };

  /** 程序生成的音乐厅脉冲响应（噪声指数衰减），免去额外素材文件 */
  AudioEngine.prototype._makeImpulseResponse = function (duration, decay) {
    var rate = this.ctx.sampleRate;
    var len = Math.max(1, Math.floor(rate * duration));
    var buf = this.ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        var t = i / len;
        // 前期反射感：轻微起伏包络
        var env = Math.pow(1 - t, decay) * (0.75 + 0.25 * Math.sin(i * 0.00007));
        d[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return buf;
  };

  AudioEngine.prototype.setMasterVolume = function (v) {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  };

  AudioEngine.prototype.setReverb = function (amount) {
    if (!this.ctx) return;
    amount = Math.max(0, Math.min(1, amount));
    this.wet.gain.setTargetAtTime(amount * 0.9, this.ctx.currentTime, 0.05);
    this.dry.gain.setTargetAtTime(1 - amount * 0.22, this.ctx.currentTime, 0.05);
  };

  AudioEngine.prototype.setTimbre = function (id, map, cfg) {
    this.allNotesOff(true);
    this.timbre = { id: id, map: map, cfg: cfg };
  };

  /* ---------------- 发音 ---------------- */

  AudioEngine.prototype.noteOn = function (midi, velocity) {
    if (!this.ctx) return;
    velocity = velocity == null ? 0.85 : velocity;

    this._stealIfNeeded();

    var t = this.ctx.currentTime;
    var prev = this.voices.get(midi);
    if (prev && prev.length) {
      for (var i = 0; i < prev.length; i++) this._releaseVoice(prev[i], t, 0.045);
      prev.length = 0;
    }

    var voice;
    if (this.timbre.id === 'dream' || !this.timbre.map) {
      voice = this._createSynthVoice(midi, velocity, t);
    } else {
      voice = this._createSampleVoice(midi, velocity, t);
    }
    if (!voice) return;

    voice.midi = midi;
    voice.startAt = t;
    this.voices.set(midi, this.voices.get(midi) || []);
    this.voices.get(midi).push(voice);
    this.activeVoices.push(voice);
    if (this.onVoiceStart) this.onVoiceStart(midi);
  };

  AudioEngine.prototype._createSampleVoice = function (midi, velocity, t) {
    var map = this.timbre.map;
    var buffer = map.get(midi);
    var rate = 1;
    if (!buffer) {
      // 缺音符时用最近的采样变调播放，保证不哑火
      var best = null, bestDist = Infinity;
      map.forEach(function (_b, k) {
        var d = Math.abs(k - midi);
        if (d < bestDist) { bestDist = d; best = k; }
      });
      if (best === null) return null;
      buffer = map.get(best);
      rate = Math.pow(2, (midi - best) / 12);
    }

    var c = this.ctx;
    var src = c.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;

    var cfg = this.timbre.cfg || {};
    var peak = (cfg.gain || 1) * Math.pow(velocity, 1.55);
    var g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.001), t + 0.005);
    // 采样本身自带自然衰减，这里只做极轻微的额外衰减，长按时更接近真琴
    g.gain.setTargetAtTime(peak * 0.82, t + 0.02, 3.5);

    src.connect(g);
    var node = this._attachOutput(src, g, midi);
    src.start(t);
    return { src: src, gain: g, out: node, multi: null };
  };

  AudioEngine.prototype._createSynthVoice = function (midi, velocity, t) {
    var c = this.ctx;
    var freq = 440 * Math.pow(2, (midi - 69) / 12);

    var o1 = c.createOscillator(); o1.type = 'triangle'; o1.frequency.value = freq;
    var o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq; o2.detune.value = 7;
    var o3 = c.createOscillator(); o3.type = 'sine'; o3.frequency.value = freq * 2;

    var g3 = c.createGain(); g3.gain.value = 0.14;
    var g = c.createGain();
    var lp = c.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.value = Math.min(11000, 900 + freq * 3.2);
    lp.Q.value = 0.4;

    var peak = 0.5 * Math.pow(velocity, 1.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.012);
    g.gain.setTargetAtTime(peak * 0.32, t + 0.012, 0.85);

    o1.connect(g); o2.connect(g); o3.connect(g3); g3.connect(g);
    g.connect(lp);

    var out = this._attachOutput(lp, lp, midi);
    o1.start(t); o2.start(t); o3.start(t);

    var oscs = [o1, o2, o3];
    return {
      src: { stop: function (when) { for (var i = 0; i < oscs.length; i++) { try { oscs[i].stop(when); } catch (e) {} } } },
      gain: g, out: out, multi: oscs
    };
  };

  /** 挂接声像与总线，返回最终接入总线的节点 */
  AudioEngine.prototype._attachOutput = function (src, envNode, midi) {
    var tail = envNode;
    if (this.ctx.createStereoPanner) {
      var pan = this.ctx.createStereoPanner();
      pan.pan.value = Math.max(-0.42, Math.min(0.42, (midi - 62) / 36 * 0.4));
      envNode.connect(pan);
      tail = pan;
    }
    tail.connect(this.bus);
    return tail;
  };

  /* ---------------- 止音 / 踏板 ---------------- */

  AudioEngine.prototype.noteOff = function (midi) {
    var arr = this.voices.get(midi);
    if (!arr || !arr.length) return;
    if (this.pedalDown) {
      for (var i = 0; i < arr.length; i++) arr[i].sustained = true;
      this.sustainedNotes.add(midi);
      return;
    }
    var t = this.ctx.currentTime;
    for (var j = 0; j < arr.length; j++) this._releaseVoice(arr[j], t);
    arr.length = 0;
  };

  AudioEngine.prototype._releaseVoice = function (v, t, forceTau) {
    if (v.released) return;
    v.released = true;
    var cfg = this.timbre.cfg || {};
    var tau = forceTau != null ? forceTau : Math.max(0.03, (cfg.release || 0.12) / 3.2);
    var g = v.gain ? v.gain.gain : null;
    if (g) {
      if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
      else g.cancelScheduledValues(t);
      g.setTargetAtTime(0.0001, t, tau);
    }
    try { v.src.stop(t + tau * 7 + 0.06); } catch (e) {}
  };

  AudioEngine.prototype._collectGarbage = function () {
    this.activeVoices = this.activeVoices.filter(function (v) { return !v.released; });
  };

  AudioEngine.prototype._stealIfNeeded = function () {
    this._collectGarbage();
    if (this.activeVoices.length < this.maxVoices) return;
    // 偷取最早的声道，避免低配设备过载
    var oldest = null;
    for (var i = 0; i < this.activeVoices.length; i++) {
      if (!this.activeVoices[i].released && (!oldest || this.activeVoices[i].startAt < oldest.startAt)) {
        oldest = this.activeVoices[i];
      }
    }
    if (oldest) {
      this._releaseVoice(oldest, this.ctx.currentTime, 0.03);
      var arr = this.voices.get(oldest.midi);
      if (arr) {
        var idx = arr.indexOf(oldest);
        if (idx >= 0) arr.splice(idx, 1);
      }
    }
  };

  AudioEngine.prototype.setPedal = function (down) {
    if (!this.ctx || down === this.pedalDown) return;
    this.pedalDown = down;
    if (!down) {
      // 抬起踏板：释放所有被延音的音
      var t = this.ctx.currentTime;
      var self = this;
      this.sustainedNotes.forEach(function (midi) {
        var arr = self.voices.get(midi);
        if (arr) {
          for (var i = 0; i < arr.length; i++) {
            if (arr[i].sustained && !arr[i].released) self._releaseVoice(arr[i], t);
          }
          self.voices.set(midi, arr.filter(function (v) { return !v.released; }));
        }
      });
      this.sustainedNotes.clear();
    }
  };

  AudioEngine.prototype.allNotesOff = function (hard) {
    if (!this.ctx) return;
    var t = this.ctx.currentTime;
    var self = this;
    this.voices.forEach(function (arr) {
      for (var i = 0; i < arr.length; i++) self._releaseVoice(arr[i], t, hard ? 0.015 : undefined);
    });
    this.voices.clear();
    this.sustainedNotes.clear();
    if (!hard) this.pedalDown = false;
  };

  window.AudioEngine = new AudioEngine();
})();
