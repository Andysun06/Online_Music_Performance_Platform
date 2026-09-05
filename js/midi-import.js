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
    var out = spansToEvents(notes, tickToMs, shift, '移调后没有音符落在钢琴音域内');
    out.format = format;
    out.trackCount = ntrk;
    out.octaveShift = shift;
    out.smpte = smpteMsPerTick !== null;
    return out;
  }

  /** 把 {n, s(ms), e, v} 音符跨度序列转成事件（含过滤与和弦合并），返回事件与统计 */
  function spansToEvents(notes, toMs, shift, emptyMsg) {
    var msNotes = [];
    var dropped = 0;
    for (var j = 0; j < notes.length; j++) {
      var nt = notes[j];
      var n2 = nt.n + (shift || 0) * 12;
      if (n2 < LOW || n2 > HIGH) { dropped++; continue; }
      var st = toMs(nt.s);
      var et = Math.max(toMs(nt.e), st + 30);
      msNotes.push({ n: n2, s: st, e: et, v: nt.v == null ? 0.8 : Math.max(0.15, Math.min(1, nt.v)) });
    }
    if (!msNotes.length) throw new Error(emptyMsg || '没有音符落在钢琴音域内');
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
      duration: duration
    };
  }

  /* ============================================================
   * Everyone Piano .eop 文件解析（格式依据 eop2midi 项目逆向规范）
   *  - 32 字节循环 XOR 掩码混淆，解码后头部 13 字节为 "EveryonePiano"
   *  - v200/v201/v301 三种布局；事件为 16 字节记录（毫秒时间戳 + 键盘码）
   *  - 键盘码经映射表转为 MIDI 音高
   * ============================================================ */

  var EOP_XOR = [
    0x71, 0x72, 0x73, 0x74, 0x72, 0x73, 0x74, 0x75,
    0x73, 0x74, 0x75, 0x76, 0x74, 0x75, 0x76, 0x77,
    0x75, 0x76, 0x77, 0x78, 0x76, 0x77, 0x78, 0x79,
    0x77, 0x78, 0x79, 0x7a, 0x78, 0x79, 0x7a, 0x7b
  ];

  function eopDecode(raw) {
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw[i] ^ EOP_XOR[i % 32];
    return out;
  }

  function eopText(bytes) {
    var seg = bytes;
    var nul = seg.indexOf(0);
    if (nul >= 0) seg = seg.subarray(0, nul);
    if (!seg.length) return '';
    try { return new TextDecoder('utf-8', { fatal: true }).decode(seg); }
    catch (e) { try { return new TextDecoder('gbk').decode(seg); } catch (e2) { return ''; } }
  }

  function eopParseKeyMappings(dv, u8, sectionStart, sectionSize, recordSize) {
    if (sectionSize < 28 || (sectionSize - 28) % recordSize !== 0) throw new Error('mapping section 尺寸不合法');
    var records = (sectionSize - 28) / recordSize;
    var map = {};
    for (var i = 0; i < records; i++) {
      var off = sectionStart + 28 + i * recordSize;
      var scanCode = u8[off + 4];
      if (map[scanCode] !== undefined) throw new Error('mapping 重复键盘码');
      var action = dv.getUint16(off + 32, true);
      var note = dv.getUint16(off + 34, true);
      if (action === 0x0090 && note <= 127) map[scanCode] = note;
    }
    return map;
  }

  function eopParseLengthPrefixed(dv, u8, start, end, recordSize) {
    var sections = [];
    var cursor = start;
    while (cursor < end) {
      if (end - cursor < 4) throw new Error('mapping 容器被截断');
      var sectionSize = dv.getUint32(cursor, true);
      var sectionStart = cursor + 4;
      if (sectionSize < 28 || sectionSize > end - sectionStart) throw new Error('mapping section 越界');
      sections.push(eopParseKeyMappings(dv, u8, sectionStart, sectionSize, recordSize));
      cursor = sectionStart + sectionSize;
    }
    if (!sections.length) throw new Error('mapping 容器为空');
    return sections;
  }

  function eopMergeSections(sections) {
    var merged = {};
    for (var s = 0; s < sections.length; s++) {
      var sec = sections[s];
      for (var code in sec) {
        if (merged[code] === undefined) merged[code] = sec[code];
      }
    }
    return merged;
  }

  function eopParseEvents(dv, u8, start, count, mapping, velocities) {
    var notes = []; // {n, s, e, v}  单位毫秒
    var open = {};
    var dropped = 0;
    var prev = -1;
    for (var i = 0; i < count; i++) {
      var off = start + i * 16;
      var ts = dv.getFloat64(off, true);
      if (!(ts >= 0) || ts < prev) throw new Error('事件时间轴非法');
      prev = ts;
      var status = u8[off + 8];
      if (status !== 0x80 && status !== 0x90) throw new Error('事件状态非法 0x' + status.toString(16));
      var scanCode = u8[off + 9];
      var note = mapping[scanCode];
      if (note === undefined) { dropped++; continue; }   // 宽容模式：跳过未映射键盘码
      var vel = u8[off + 10] / 127;
      if (status === 0x90 && velocities && velocities[scanCode]) vel = velocities[scanCode] / 127;
      var key = scanCode * 128 + note;
      if (status === 0x90) {
        if (open[key]) notes.push({ n: note, s: open[key].s, e: ts, v: open[key].v });
        open[key] = { s: ts, v: vel };
      } else if (open[key]) {
        notes.push({ n: note, s: open[key].s, e: ts, v: open[key].v });
        delete open[key];
      }
    }
    for (var k in open) notes.push({ n: (+k) % 128, s: open[k].s, e: prev + 500, v: open[k].v });
    return { notes: notes, dropped: dropped };
  }

  function finishEop(out, meta) {
    var r = spansToEvents(out.notes, function (ms) { return ms; }, 0, 'EOP 中没有可用的钢琴音符');
    return {
      events: r.events,
      noteCount: r.noteCount,
      droppedCount: out.dropped,
      duration: r.duration,
      title: meta.title,
      author: meta.author,
      eopVersion: meta.version,
      tempo: meta.tempo
    };
  }

  function parseEop(buffer) {
    var raw = new Uint8Array(buffer);
    if (raw.length < 0x1bc) throw new Error('文件比 EOP 头还短');
    var decodedHead = eopDecode(raw.subarray(0, 0x1bc));
    var magic = '';
    for (var i = 0; i < 13; i++) magic += String.fromCharCode(decodedHead[i]);
    if (magic !== 'EveryonePiano') throw new Error('不是有效的 EOP 文件（缺少 EveryonePiano 签名）');
    var dvHead = new DataView(decodedHead.buffer);
    var version = dvHead.getUint32(0x10, true);
    var tempo = dvHead.getUint32(0x1c, true);
    var title = eopText(decodedHead.subarray(0x134, 0x174));
    var author = eopText(decodedHead.subarray(0x174, 0x1b4));

    var payload = raw;
    if (version === 200 && raw[raw.length - 1] === 0) payload = raw.subarray(0, raw.length - 1);
    var decoded = eopDecode(payload);
    var dv = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
    var u8 = decoded;

    var mapping, eventStart;
    if (version === 200) {
      var blockCount = dv.getUint32(0x20, true);
      if (blockCount < 1 || blockCount > 4) throw new Error('v200 blockCount 越界');
      var mappingStart = 0x1b8 + (blockCount - 1) * 0x184;
      var recordStart = mappingStart + 28;
      eventStart = recordStart + 255 * 12 + 28;
      if (eventStart > decoded.length) throw new Error('v200 映射表越界');
      var leftVel = dv.getUint32(mappingStart + 12, true);
      var rightVel = dv.getUint32(mappingStart + 16, true);
      if (leftVel > 127 || rightVel > 127) throw new Error('v200 力度越界');
      mapping = {};
      var velocities = {};
      for (var r = 0; r < 255; r++) {
        var off = recordStart + r * 12;
        var scanCode = dv.getUint32(off, true);
        var action = dv.getUint32(off + 4, true);
        var note = dv.getUint32(off + 8, true);
        if (scanCode !== r + 1) throw new Error('v200 映射表校验失败');
        if ((action === 0x00000001 || action === 0x00010001) && note <= 127) {
          mapping[scanCode] = note;
          velocities[scanCode] = action === 0x00010001 ? leftVel : rightVel;
        }
      }
      var pool = decoded.length - eventStart;
      if (pool < 16 || pool % 16 !== 0) throw new Error('v200 事件池不合法');
      var terminator = -1;
      for (var e = 0; e < pool / 16; e++) {
        if (u8[eventStart + e * 16 + 8] === 0) { terminator = e; break; }
      }
      if (terminator < 0) throw new Error('v200 缺少事件终止符');
      var out200 = eopParseEvents(dv, u8, eventStart, terminator, mapping, velocities);
      return finishEop(out200, { version: version, tempo: tempo, title: title, author: author });
    }

    if (version === 201 || version === 301) {
      var recordSize = version === 201 ? 42 : 52;
      var firstSectionSize = dv.getUint32(0x1b8, true);
      if (firstSectionSize !== 0) {
        var containerSize = dv.getUint32(0x28, true) || (4 + firstSectionSize);
        var containerEnd = 0x1b8 + containerSize;
        if (containerSize < 4 || containerEnd > decoded.length) throw new Error('mapping 容器越界');
        mapping = eopMergeSections(eopParseLengthPrefixed(dv, u8, 0x1b8, containerEnd, recordSize));
        eventStart = containerEnd;
      } else {
        // v201 零区段变体：mapping 与事件段在文件尾部
        var mappingContainerSize = dv.getUint32(0x28, true);
        var eventContainerSize = dv.getUint32(0x2c, true);
        if (mappingContainerSize < 4 || eventContainerSize < 16 || eventContainerSize % 16 !== 0) throw new Error('零区段布局不合法');
        var eStart = decoded.length - eventContainerSize;
        var mStart = eStart - (mappingContainerSize - 4);
        if (mStart < 0) throw new Error('零区段布局越界');
        mapping = eopParseV201ZeroSections(dv, u8, mStart, eStart, recordSize);
        eventStart = eStart;
      }
      var poolLen = decoded.length - eventStart;
      if (poolLen < 32 || poolLen % 16 !== 0) throw new Error('事件区不合法');
      var count = (poolLen - 16) / 16;
      if (count > 0) {
        var st0 = u8[eventStart + 8];
        if (st0 !== 0x80 && st0 !== 0x90) throw new Error('事件区起点不合法');
      }
      var out = eopParseEvents(dv, u8, eventStart, count, mapping, null);
      return finishEop(out, { version: version, tempo: tempo, title: title, author: author });
    }

    throw new Error('不支持的 EOP 版本 ' + version);
  }

  function eopParseV201ZeroSections(dv, u8, start, end, recordSize) {
    var matches = [];
    for (var firstSize = 28; firstSize <= end - start; firstSize += recordSize) {
      try {
        var first = eopParseKeyMappings(dv, u8, start, firstSize, recordSize);
        var sections = [first];
        if (start + firstSize < end) {
          var rest = eopParseLengthPrefixed(dv, u8, start + firstSize, end, recordSize);
          sections = sections.concat(rest);
        }
        matches.push(eopMergeSections(sections));
      } catch (e) { /* 尝试下一种切分 */ }
    }
    if (matches.length === 0) throw new Error('零区段 mapping 无有效切分');
    if (matches.length > 1) throw new Error('零区段 mapping 存在多种切分');
    return matches[0];
  }

  window.MidiImport = { parse: parse, parseEop: parseEop };
})();
