/* ============================================================
 * songs.js — 内置自动演奏乐曲
 *
 * 事件格式：{ t: 起始毫秒, notes: [midi...], d: 持续毫秒 }
 * 和弦（多音）写在同一事件的 notes 数组里。
 * ============================================================ */
(function () {
  'use strict';

  var NAMES = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
  function N(name) {
    var m = /^([A-G][b#]?)(-?\d)$/.exec(name);
    return (parseInt(m[2], 10) + 1) * 12 + NAMES[m[1]];
  }

  /** 辅助：按「音符名 时值（拍）」序列展开成事件 */
  function melody(bpm, seq, opts) {
    var beat = 60000 / bpm;
    opts = opts || {};
    var t = (opts.leadIn || 0) * beat;
    var events = [];
    for (var i = 0; i < seq.length; i++) {
      var notes = Array.isArray(seq[i][0]) ? seq[i][0] : [seq[i][0]];
      var beats = seq[i][1];
      var dur = Math.max(0.15, beats * beat * (opts.stac || 0.92));
      events.push({ t: Math.round(t), notes: notes.map(N), d: Math.round(dur) });
      t += beats * beat;
    }
    return events;
  }

  /**
   * 简谱（数字谱）助手：基于某调的 do 音高，把 [度数, 拍数] 序列展开。
   * 度数写法：'5' 中音，'i5' 高音，'l5' 低音，'r' 休止。
   */
  function jianpu(baseMidi, bpm, bars, opts) {
    opts = opts || {};
    var OFF = { '1': 0, '2': 2, '3': 4, '4': 5, '5': 7, '6': 9, '7': 11 };
    var beat = 60000 / bpm;
    var t = (opts.leadIn || 0) * beat;
    var events = [];
    function deg(sym) {
      var oct = 0, s = sym;
      while (s.charAt(0) === 'i') { oct++; s = s.slice(1); }
      while (s.charAt(0) === 'l') { oct--; s = s.slice(1); }
      return baseMidi + OFF[s] + 12 * oct;
    }
    bars.forEach(function (bar) {
      bar.forEach(function (tok) {
        var beats = tok[1];
        if (tok[0] !== 'r') {
          var notes = Array.isArray(tok[0]) ? tok[0] : [tok[0]];
          events.push({ t: Math.round(t), notes: notes.map(deg), d: Math.round(beats * beat * (opts.stac || 0.94)) });
        }
        t += beats * beat;
      });
    });
    return events;
  }

  /** 左手分解伴奏：按小节给出和弦根音，播 [根,五度,高八度,五度] 四分音符 */
  function chords(bpm, rootsPerBar, beatsPerBar, opts) {
    opts = opts || {};
    var beat = 60000 / bpm;
    var t = (opts.leadIn || 0) * beat;
    var events = [];
    rootsPerBar.forEach(function (root) {
      if (root != null) {
        var pat = [root, root + 7, root + 12, root + 7];
        pat.forEach(function (n, i) {
          events.push({ t: Math.round(t + i * beat), notes: [n], d: Math.round(beat * 0.95) });
        });
      }
      t += beatsPerBar * beat;
    });
    return events;
  }

  /* ==================== 小星星 ==================== */
  var songs = [];
  songs.push({
    id: 'twinkle', name: '小星星',
    events: melody(108, [
      ['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1], ['A4', 1], ['A4', 1], ['G4', 2],
      ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 1], ['D4', 1], ['C4', 2],
      ['G4', 1], ['G4', 1], ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 2],
      ['G4', 1], ['G4', 1], ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 2],
      ['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1], ['A4', 1], ['A4', 1], ['G4', 2],
      ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 1], ['D4', 1], ['C4', 2]
    ])
  });

  /* ==================== 欢乐颂 ==================== */
  var ode = [
    ['E4', 1], ['E4', 1], ['F4', 1], ['G4', 1],
    ['G4', 1], ['F4', 1], ['E4', 1], ['D4', 1],
    ['C4', 1], ['C4', 1], ['D4', 1], ['E4', 1],
    ['E4', 1.5], ['D4', 0.5], ['D4', 2],
    ['E4', 1], ['E4', 1], ['F4', 1], ['G4', 1],
    ['G4', 1], ['F4', 1], ['E4', 1], ['D4', 1],
    ['C4', 1], ['C4', 1], ['D4', 1], ['E4', 1],
    ['D4', 1.5], ['C4', 0.5], ['C4', 2],
    [['D4', 'B3'], 1], [['D4', 'B3'], 1], [['D4', 'C4'], 1], [['E4', 'C4'], 1],
    [['E4', 'A3'], 1], [['D4', 'G3'], 1], [['C4', 'G3'], 1], ['E4', 1],
    [['D4', 'B3'], 1], [['D4', 'B3'], 1], [['D4', 'C4'], 1], [['E4', 'C4'], 1],
    [['D4', 'G3'], 1.5], [['C4', 'E3'], 0.5], [['C4', 'C3'], 2]
  ];
  songs.push({ id: 'ode', name: '欢乐颂 · 贝多芬', events: melody(132, ode, { stac: 0.88 }) });

  /* ==================== 致爱丽丝 ==================== */
  (function () {
    var p = 165;
    var ev = [];
    function add(t, notes, d) { ev.push({ t: t, notes: notes.map(N), d: d }); }
    function arp(ns, start) { for (var i = 0; i < ns.length; i++) add(start + i * p, [ns[i]], p); }

    for (var r = 0; r < 2; r++) {
      var o = r * 27 * p;
      add(o + 0 * p, ['E5'], p); add(o + 1 * p, ['D#5'], p); add(o + 2 * p, ['E5'], p);
      add(o + 3 * p, ['D#5'], p); add(o + 4 * p, ['E5'], p); add(o + 5 * p, ['B4'], p);
      add(o + 6 * p, ['D5'], p); add(o + 7 * p, ['C5'], p);
      add(o + 8 * p, ['A4'], 3 * p); arp(['A2', 'E3', 'A3'], o + 8 * p);
      add(o + 11 * p, ['B4'], 3 * p); arp(['E3', 'G#3', 'B3'], o + 11 * p);
      add(o + 14 * p, ['C5'], 3 * p); arp(['A2', 'E3', 'A3'], o + 14 * p);
      if (r === 0) {
        add(o + 17 * p, ['B4'], p); add(o + 18 * p, ['E4'], p); add(o + 19 * p, ['E5'], p);
      } else {
        add(o + 17 * p, ['B4'], 2 * p); add(o + 19 * p, ['C5'], p);
        add(o + 20 * p, ['B4'], p); add(o + 21 * p, ['A4'], 4 * p);
        arp(['A2', 'E3', 'A3'], o + 21 * p);
      }
    }
    songs.push({ id: 'elise', name: '致爱丽丝 · 贝多芬（片段）', events: ev });
  })();

  /* ==================== 卡农 ==================== */
  (function () {
    var bpm = 72;
    var beat = 60000 / bpm;
    var prog = [
      ['D4', 'A4', 'F#5'], ['D4', 'A4', 'F#5'],
      ['G3', 'B3', 'G4'], ['G3', 'B3', 'G4'],
      ['D4', 'A4', 'F#4'], ['D4', 'A4', 'F#4'],
      ['A3', 'E4', 'A4'], ['A3', 'E4', 'A4'],
      ['B3', 'D4', 'B4'], ['B3', 'D4', 'B4'],
      ['F#4', 'A4', 'D5'], ['F#4', 'A4', 'D5'],
      ['G4', 'B4', 'G5'], ['G4', 'B4', 'G5'],
      ['D4', 'G4', 'B4'], ['D4', 'G4', 'B4'],
      ['D4', 'A4', 'F#5'], ['D4', 'A4', 'F#5']
    ];
    var ev = [];
    var t = 0;
    for (var i = 0; i < prog.length; i++) {
      var chord = prog[i];
      ev.push({ t: Math.round(t), notes: [N(chord[0])], d: Math.round(beat) });
      ev.push({ t: Math.round(t + beat * 0.5), notes: [N(chord[1])], d: Math.round(beat * 0.5) });
      ev.push({ t: Math.round(t + beat), notes: [N(chord[2])], d: Math.round(beat) });
      t += beat * 2;
    }
    songs.push({ id: 'canon', name: '卡农 · 帕赫贝尔（片段）', events: ev });
  })();

  /* ==================== 星辰大海 / 左手指月 ====================
   * 精确曲谱来自 EveryonePiano 社区转录（.eop 解析），数据在 pop-songs-data.js
   */
  (window.POP_SONGS || []).forEach(function (s) { songs.push(s); });

  window.SONGS = songs;
})();
