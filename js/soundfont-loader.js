/* ============================================================
 * soundfont-loader.js — 钢琴音色加载与解码
 *
 * 音色采样来自 gleitz/midi-js-soundfonts（MusyngKite / FluidR3_GM），
 * 文件内为 base64 mp3 的自注册 JS，通过 <script> 注入即可在 file:// 下工作。
 * ============================================================ */
(function () {
  'use strict';

  var NOTE_RE = /^([A-G])(b|#)?(-?\d)$/;
  var SHARP_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  var FLAT_SEMI = { Db: 1, Eb: 3, Gb: 6, Ab: 8, Bb: 10 };

  /** "Bb3" / "F#2" / "C4" -> MIDI 编号 */
  function noteToMidi(name) {
    var m = NOTE_RE.exec(name);
    if (!m) return null;
    var semi;
    if (m[2] === 'b') semi = FLAT_SEMI[m[1] + 'b'];
    else if (m[2] === '#') semi = (SHARP_SEMI[m[1]] + 1) % 12;
    else semi = SHARP_SEMI[m[1]];
    if (semi == null) return null;
    return (parseInt(m[3], 10) + 1) * 12 + semi;
  }

  var TIMBRES = [
    {
      id: 'grand', name: '古典三角钢琴', sub: '音乐会级采样', kind: 'sample',
      file: 'samples/soundfonts/MusyngKite_acoustic_grand_piano-mp3.js',
      setName: 'acoustic_grand_piano',
      release: 0.13, gain: 0.95
    },
    {
      id: 'bright', name: '明亮立式钢琴', sub: '清亮通透', kind: 'sample',
      file: 'samples/soundfonts/FluidR3_GM_bright_acoustic_piano-mp3.js',
      setName: 'bright_acoustic_piano',
      release: 0.10, gain: 0.82
    },
    {
      id: 'rhodes', name: '复古电钢琴', sub: 'Rhodes 风味', kind: 'sample',
      file: 'samples/soundfonts/FluidR3_GM_electric_piano_1-mp3.js',
      setName: 'electric_piano_1',
      release: 0.20, gain: 0.92
    },
    {
      id: 'honky', name: '酒馆钢琴', sub: 'Honky-Tonk', kind: 'sample',
      file: 'samples/soundfonts/FluidR3_GM_honkytonk_piano-mp3.js',
      setName: 'honkytonk_piano',
      release: 0.09, gain: 0.85
    },
    {
      id: 'dream', name: '梦幻合成音色', sub: '内置合成器 · 离线秒开', kind: 'synth',
      release: 0.45, gain: 0.8
    }
  ];

  var injectedFiles = {};   // file -> true（脚本只注入一次，base64 常驻内存，体积可接受）
  var decodedCache = null;  // { id, map } 只缓存最近一个音色的解码结果，控制内存

  function loadScript(file) {
    if (injectedFiles[file]) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = file;
      s.onload = function () { injectedFiles[file] = true; resolve(); };
      s.onerror = function () { reject(new Error('音色文件加载失败: ' + file)); };
      document.head.appendChild(s);
    });
  }

  function base64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  /**
   * 加载并解码一个采样音色。
   * @returns Promise<Map<midi, AudioBuffer>>  synth 音色返回 null
   */
  function loadTimbre(ctx, id, onProgress) {
    var t = null;
    for (var i = 0; i < TIMBRES.length; i++) if (TIMBRES[i].id === id) t = TIMBRES[i];
    if (!t) return Promise.reject(new Error('未知音色: ' + id));
    if (t.kind === 'synth') return Promise.resolve(null);

    if (decodedCache && decodedCache.id === id) {
      return Promise.resolve(decodedCache.map);
    }

    return loadScript(t.file).then(function () {
      var sf = window.MIDI && window.MIDI.Soundfont && window.MIDI.Soundfont[t.setName];
      if (!sf) throw new Error('音色数据缺失: ' + t.setName);

      var names = Object.keys(sf);
      var map = new Map();
      var done = 0;

      return Promise.all(names.map(function (name) {
        var midi = noteToMidi(name);
        if (midi == null) { done++; return Promise.resolve(); }
        var b64 = sf[name].split(',')[1];
        return new Promise(function (res) {
          ctx.decodeAudioData(base64ToArrayBuffer(b64), function (buf) {
            map.set(midi, buf);
            res();
          }, function () { res(); /* 单个音符解码失败不影响整体 */ });
        }).then(function () {
          done++;
          if (onProgress) onProgress(done, names.length, '解码采样 ' + done + ' / ' + names.length);
        });
      })).then(function () {
        if (map.size === 0) throw new Error('采样解码失败');
        decodedCache = { id: id, map: map };
        return map;
      });
    });
  }

  function timbreById(id) {
    for (var i = 0; i < TIMBRES.length; i++) if (TIMBRES[i].id === id) return TIMBRES[i];
    return TIMBRES[0];
  }

  window.SoundfontLoader = {
    TIMBRES: TIMBRES,
    noteToMidi: noteToMidi,
    loadTimbre: loadTimbre,
    timbreById: timbreById
  };
})();
