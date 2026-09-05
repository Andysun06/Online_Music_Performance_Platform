/* ============================================================
 * midi-import.js — 标准 MIDI 文件（SMF）解析器
 *
 * 把 .mid 转成自动演奏事件序列：{ t, notes:[midi...], d }
 *  - 支持 format 0/1（format 2 按顺序拼接）、running status、SMPTE 时基
 *  - 自动跟随曲速变化（tempo meta 0x51）
 *  - 跳过 GM 鼓轨（channel 10）
 *  - 自动整体移调到钢琴音域（A0–C8），放不下的音丢弃并计入统计
 * ============================================================ */
(function () {
  'use strict';

  var LOW = 21, HIGH = 108; // 钢琴音域

  function parse(buffer) {
    var data = new Uint8Array(buffer);
    var pos = 0;

    function str(n) { var s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(data[pos++]); return s; }
    function u32() { var v = ((data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3]) >>> 0; pos += 4; return v; }
    function u16() { var v = (data[pos] << 8) | data[pos + 1]; pos += 2; return v; }
    function vlq() { var v = 0, b; do { b = data[pos++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; }

    if (data.length < 14 || str(4) !== 'MThd') throw new Error('不是有效的 MIDI 文件（缺少 MThd 头）');
    var hdLen = u32();
    var format = u16(), ntrk = u16(), division = u16();
    pos += hdLen - 6;

    var smpteMsPerTick = null;
    if (division & 0x8000) {
      var negFps = division >> 8;                    // 有符号字节，如 0xE7 = -25
      var fps = 256 - negFps;
      var ticksPerFrame = division & 0xff;
      smpteMsPerTick = 1000 / (fps * ticksPerFrame);
    }

    var notes = [];   // {n, s, e, v}
    var tempos = [];  // {tick, usq}

    for (var t = 0; t < ntrk && pos + 8 <= data.length; t++) {
      var id = str(4);
      var len = u32();
      if (id !== 'MTrk') { pos += len; t--; continue; }
      var end = Math.min(pos + len, data.length);
      var tick = 0, runStatus = 0;
      var open = {};   // (ch<<9)|note -> {s, v}

      while (pos < end) {
        tick += vlq();
        var status = data[pos];
        if (status < 0x80) { status = runStatus; }
        else { pos++; if (status < 0xf0) runStatus = status; }

        if (status === 0xff) {
          if (pos >= end) break;
          var type = data[pos++];
          var mlen = vlq();
          if (type === 0x51 && mlen === 3 && pos + 3 <= end) {
            tempos.push({ tick: tick, usq: (data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2] });
          }
          pos += mlen;
        } else if (status === 0xf0 || status === 0xf7) {
          var slen = vlq();   // 注意：vlq 已移动 pos，长度需另存再跳
          pos += slen;
        } else {
          var hi = status & 0xf0, ch = status & 0x0f;
          if (hi === 0x90 || hi === 0x80) {
            var note = data[pos++], vel = data[pos++];
            if (ch === 9) continue;   // GM 鼓轨跳过
            var key = (ch << 9) | note;
            var isOn = hi === 0x90 && vel > 0;
            if (isOn) {
              if (open[key]) notes.push({ n: note, s: open[key].s, e: tick, v: open[key].v });
              open[key] = { s: tick, v: vel };
            } else if (open[key]) {
              notes.push({ n: note, s: open[key].s, e: tick, v: open[key].v });
              delete open[key];
            }
          } else if (hi === 0xc0 || hi === 0xd0) pos += 1;
          else pos += 2;
        }
      }
      for (var k in open) notes.push({ n: (+k) & 0x7f, s: open[k].s, e: tick, v: open[k].v });
      pos = end;
    }

    if (!notes.length) throw new Error('MIDI 中没有解析到任何音符');

    /* ---- 自动移调到钢琴音域（平手时优先不移调） ---- */
    var shift = 0, bestFit = -1;
    var shiftOrder = [0, -1, 1, -2, 2, -3, 3];
    for (var si = 0; si < shiftOrder.length; si++) {
      var s = shiftOrder[si];
      var fit = 0;
      for (var i = 0; i < notes.length; i++) {
        var nn = notes[i].n + s * 12;
        if (nn >= LOW && nn <= HIGH) fit++;
      }
      if (fit > bestFit) { bestFit = fit; shift = s; }
    }

    /* ---- tick -> 毫秒 ---- */
    tempos.sort(function (a, b) { return a.tick - b.tick; });
    if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, usq: 500000 });

    function tickToMs(tick) {
      if (smpteMsPerTick !== null) return tick * smpteMsPerTick;
      var ms = 0, lastTick = 0, usq = tempos[0].usq;
      for (var i = 0; i < tempos.length; i++) {
        var tp = tempos[i];
        if (tp.tick >= tick) break;
        ms += (tp.tick - lastTick) * (usq / 1000 / division);
        lastTick = tp.tick;
        usq = tp.usq;
      }
      ms += (tick - lastTick) * (usq / 1000 / division);
      return ms;
    }

    /* ---- 排序、过滤、按时间分组合并为事件 ---- */
    var msNotes = [];
    var dropped = 0;
    for (var j = 0; j < notes.length; j++) {
      var nt = notes[j];
      var n2 = nt.n + shift * 12;
      if (n2 < LOW || n2 > HIGH) { dropped++; continue; }
      var st = tickToMs(nt.s);
      var et = Math.max(tickToMs(nt.e), st + 30);
      msNotes.push({ n: n2, s: st, e: et, v: 0.2 + 0.8 * (nt.v / 127) });
    }
    if (!msNotes.length) throw new Error('移调后没有音符落在钢琴音域内');
    msNotes.sort(function (a, b) { return a.s - b.s || a.n - b.n; });

    var events = [];
    var GROUP_MS = 20;
    var cur = null;
    for (var m = 0; m < msNotes.length; m++) {
      var x = msNotes[m];
      if (cur && x.s - cur.t <= GROUP_MS) {
        cur.notes.push(x.n);
        cur.d = Math.max(cur.d, Math.round(x.e - cur.t));
        cur.vel = Math.max(cur.vel, x.v);
      } else {
        if (cur) events.push(cur);
        cur = { t: Math.round(x.s), notes: [x.n], d: Math.round(x.e - x.s), vel: x.v };
      }
    }
    if (cur) events.push(cur);

    var duration = 0;
    for (var e = 0; e < events.length; e++) duration = Math.max(duration, events[e].t + events[e].d);

    return {
      events: events,
      noteCount: msNotes.length,
      droppedCount: dropped,
      duration: duration,
      format: format,
      trackCount: ntrk,
      octaveShift: shift,
      smpte: smpteMsPerTick !== null
    };
  }

  window.MidiImport = { parse: parse };
})();
