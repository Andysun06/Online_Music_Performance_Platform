/* ============================================================
 * main.js — 应用装配与全局交互
 * ============================================================ */
(function () {
  'use strict';

  var SETTINGS_KEY = 'resonance.settings.v1';

  var settings = {
    timbre: 'grand',
    volume: 80,        // 0-100
    reverb: 25,        // 0-100
    sustainLock: false,
    showKeys: true,
    showNotes: false,
    fxOn: true,
    fxIntensity: 100,  // 20-200
    keyPreset: 'standard'
  };

  try {
    var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (saved) for (var k in settings) if (saved[k] !== undefined) settings[k] = saved[k];
  } catch (e) {}

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  var $ = function (id) { return document.getElementById(id); };

  var ui = {
    timbreSelect: $('timbreSelect'), timbreSelect2: $('timbreSelect2'),
    volumeSlider: $('volumeSlider'), volumeSlider2: $('volumeSlider2'),
    reverbSlider: $('reverbSlider'), volVal: $('volVal'), revVal: $('revVal'),
    sustainLock: $('sustainLock'),
    showKeys: $('showKeys'), showNotes: $('showNotes'),
    fxOn: $('fxOn'), fxIntensity: $('fxIntensity'), fxVal: $('fxVal'),
    presetSelect: $('presetSelect'), presetDesc: $('presetDesc'),
    bindList: $('bindList'), resetBinds: $('resetBinds'),
    settingsDrawer: $('settingsDrawer'), settingsClose: $('settingsClose'), drawerMask: $('drawerMask'),
    btnSettings: $('btnSettings'),
    btnRecorder: $('btnRecorder'), recorderPanel: $('recorderPanel'),
    btnAutoplay: $('btnAutoplay'), autoPanel: $('autoPanel'),
    recToggle: $('recToggle'), recPlay: $('recPlay'), recStop: $('recStop'),
    recClear: $('recClear'), recInfo: $('recInfo'),
    songSelect: $('songSelect'), modeAuto: $('modeAuto'), modeFollow: $('modeFollow'),
    autoToggle: $('autoToggle'), autoInfo: $('autoInfo'),
    octaveLabel: $('octaveLabel'),
    welcome: $('welcome'), startBtn: $('startBtn'),
    toast: $('toast')
  };

  /* ---------------- Toast ---------------- */

  var toastTimer = null;
  function toast(msg, sticky) {
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(function () { ui.toast.classList.remove('show'); }, 2200);
  }
  function hideToast() {
    if (toastTimer) clearTimeout(toastTimer);
    ui.toast.classList.remove('show');
  }

  /* ---------------- 音符管线 ---------------- */

  var heldCodes = new Map(); // code -> midi
  var spaceDown = false;
  var midiPedalDown = false;
  var started = false;
  var loadingTimbre = false;

  function pedalEffective() {
    return settings.sustainLock || spaceDown || midiPedalDown;
  }
  function applyPedal() {
    AudioEngine.setPedal(pedalEffective());
  }

  function userNoteOn(midi, vel, source) {
    if (!started) return;
    // 假弹模式：用户按键被乐曲接管
    if (AutoPlayer.playing && AutoPlayer.mode === 'follow') {
      if (AutoPlayer.handleUserKey(midi)) { updateAutoInfo(); return; }
    }
    AudioEngine.ensureStarted();
    AudioEngine.noteOn(midi, vel);
    PianoUI.press(midi, source);
    Recorder.capture('on', midi, vel || 0.85);
  }

  function userNoteOff(midi, source) {
    if (!started) return;
    AudioEngine.noteOff(midi);
    PianoUI.release(midi, source);
    Recorder.capture('off', midi);
  }

  function systemNoteOn(midi, vel) {
    AudioEngine.noteOn(midi, vel);
    PianoUI.press(midi, 'auto');
  }
  function systemNoteOff(midi) {
    AudioEngine.noteOff(midi);
    PianoUI.release(midi, 'auto');
  }

  window.App = { noteOn: userNoteOn, noteOff: userNoteOff, toast: toast };

  /* ---------------- 键盘事件 ---------------- */

  document.addEventListener('keydown', function (e) {
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (bindListening) { captureBind(e); return; }

    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat && !spaceDown) { spaceDown = true; applyPedal(); }
      return;
    }
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      if (!e.repeat) {
        KeyboardMap.shiftOctave(e.code === 'ArrowRight' ? 1 : -1);
        afterMappingChange();
        toast('八度：' + KeyboardMap.rangeLabel());
      }
      return;
    }
    if (e.code === 'Escape') {
      panic();
      return;
    }
    if (e.repeat) return;

    var midi = KeyboardMap.noteForCode(e.code);
    if (midi != null) {
      e.preventDefault();
      heldCodes.set(e.code, midi);
      userNoteOn(midi, 0.85, 'kb');
      PianoUI.ensureVisible(midi);
    }
  });

  document.addEventListener('keyup', function (e) {
    if (e.code === 'Space') {
      spaceDown = false; applyPedal();
      return;
    }
    var midi = heldCodes.get(e.code);
    if (midi != null) {
      heldCodes.delete(e.code);
      userNoteOff(midi, 'kb');
    }
  });

  window.addEventListener('blur', function () {
    // 失焦时释放所有按住的键，防止“卡音”
    heldCodes.forEach(function (midi) { userNoteOff(midi, 'kb'); });
    heldCodes.clear();
    spaceDown = false; applyPedal();
  });

  function panic() {
    AutoPlayer.stop();
    Recorder.stopPlay();
    Recorder.recording = false;
    AudioEngine.setPedal(false);
    AudioEngine.allNotesOff(true);
    heldCodes.clear();
    spaceDown = false;
    PianoUI.clearAllVisual();
    refreshRecorderUI();
    refreshAutoUI();
    toast('已全部停止');
  }

  /* ---------------- 音色加载 ---------------- */

  function loadTimbre(id, silent) {
    if (loadingTimbre) return;
    var cfg = SoundfontLoader.timbreById(id);
    settings.timbre = id;
    saveSettings();

    if (cfg.kind === 'synth') {
      AudioEngine.setTimbre(id, null, cfg);
      if (!silent) toast('已切换：' + cfg.name);
      return;
    }
    loadingTimbre = true;
    if (!silent) toast('音色加载中…', true);
    var ctx = AudioEngine.ensureStarted();
    SoundfontLoader.loadTimbre(ctx, id, function (done, total, msg) {
      if (!silent && total) toast(msg + '（' + Math.round(done / total * 100) + '%）', true);
    }).then(function (map) {
      AudioEngine.setTimbre(id, map, cfg);
      if (!silent) toast('已切换：' + cfg.name);
    }).catch(function (err) {
      console.error(err);
      var hint = location.protocol === 'file:'
        ? '。直接双击打开可能被浏览器限制，请使用「启动钢琴.bat」或运行 start_server.bat'
        : '';
      toast('音色加载失败：' + err.message + hint);
    }).finally(function () {
      loadingTimbre = false;
      hideToast();
    });
  }

  /* ---------------- 设置界面 ---------------- */

  function paintRange(el) {
    var min = +el.min || 0, max = +el.max || 100;
    var pct = ((+el.value - min) / (max - min)) * 100;
    el.style.setProperty('--fill', pct + '%');
  }

  function fillTimbreOptions() {
    [ui.timbreSelect, ui.timbreSelect2].forEach(function (sel) {
      sel.innerHTML = '';
      SoundfontLoader.TIMBRES.forEach(function (t) {
        var o = document.createElement('option');
        o.value = t.id;
        o.textContent = t.name + (t.sub ? ' · ' + t.sub : '');
        sel.appendChild(o);
      });
      sel.value = settings.timbre;
    });
  }

  function fillPresetOptions() {
    ui.presetSelect.innerHTML = '';
    Object.keys(KeyboardMap.PRESETS).forEach(function (id) {
      var o = document.createElement('option');
      o.value = id;
      o.textContent = KeyboardMap.PRESETS[id].name;
      ui.presetSelect.appendChild(o);
    });
    ui.presetSelect.value = KeyboardMap.state.preset;
    ui.presetDesc.textContent = KeyboardMap.PRESETS[KeyboardMap.state.preset].desc;
  }

  var bindListening = null; // { row, midi }

  function renderBindList() {
    var map = {};
    var base = KeyboardMap.PRESETS[KeyboardMap.state.preset].map;
    for (var c in base) map[c] = base[c];
    for (var cc in KeyboardMap.state.custom) map[cc] = KeyboardMap.state.custom[cc];

    var rows = Object.keys(map).map(function (code) {
      return { code: code, midi: map[code] };
    }).sort(function (a, b) { return a.midi - b.midi; });

    ui.bindList.innerHTML = '';
    rows.forEach(function (r) {
      var div = document.createElement('div');
      div.className = 'bind-row' + (KeyboardMap.isBlack(r.midi) ? ' black-row' : '');
      var sw = document.createElement('span');
      sw.className = 'b-swatch';
      sw.style.background = KeyboardMap.isBlack(r.midi) ? '#2c2c34' : '#efe9d8';
      var note = document.createElement('span');
      note.className = 'b-note';
      note.textContent = KeyboardMap.midiName(r.midi + KeyboardMap.state.octave * 12);
      var arrow = document.createElement('span');
      arrow.className = 'b-arrow';
      arrow.textContent = '←';
      var key = document.createElement('span');
      key.className = 'b-key';
      key.textContent = KeyboardMap.codeLabel(r.code);
      if (bindListening && bindListening.code === r.code) {
        key.classList.add('listening');
        key.textContent = '按下新按键…';
      }
      var btn = document.createElement('button');
      btn.className = 'b-change';
      btn.textContent = '更换';
      btn.addEventListener('click', function () {
        bindListening = { code: r.code, midi: r.midi };
        renderBindList();
      });
      div.appendChild(sw); div.appendChild(note); div.appendChild(arrow);
      div.appendChild(key); div.appendChild(btn);
      ui.bindList.appendChild(div);
    });
  }

  function captureBind(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') { bindListening = null; renderBindList(); return; }
    // 将按下的物理键绑定到该音符（若该键原有绑定则被接管）
    KeyboardMap.setBinding(e.code, bindListening.midi);
    var boundMidi = bindListening.midi;
    bindListening = null;
    afterMappingChange();
    toast('已绑定 ' + KeyboardMap.midiName(boundMidi));
  }

  function afterMappingChange() {
    PianoUI.updateLabels();
    renderBindList();
    updateOctaveHud();
  }

  function updateOctaveHud() {
    ui.octaveLabel.textContent = KeyboardMap.rangeLabel();
    var m = KeyboardMap.PRESETS[KeyboardMap.state.preset].map;
    var min = Infinity, max = -Infinity;
    var custom = KeyboardMap.state.custom;
    function feed(n) { n += KeyboardMap.state.octave * 12; if (n < min) min = n; if (n > max) max = n; }
    for (var c in m) feed(m[c]);
    for (var c2 in custom) feed(custom[c2]);
    if (min === Infinity) return;
    PianoUI.setKeyboardRange(min, max);
  }

  /* ---------------- 录音面板 ---------------- */

  function fmtMs(ms) {
    var s = Math.floor(ms / 1000);
    return (Math.floor(s / 60) < 10 ? '0' : '') + Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  function refreshRecorderUI() {
    var rec = Recorder.recording, playing = Recorder.playing;
    ui.recToggle.classList.toggle('recording', rec);
    ui.recToggle.textContent = rec ? '■ 停止录音' : '● 开始录音';
    ui.recPlay.disabled = rec || !Recorder.events.length || playing;
    ui.recStop.disabled = !rec && !playing;
    ui.recClear.disabled = !Recorder.events.length || rec;
    if (rec) {
      ui.recInfo.textContent = '录音中 ' + fmtMs(Recorder.duration()) + ' · ' + Recorder.noteCount() + ' 音符';
    } else if (playing) {
      ui.recInfo.textContent = '回放中…';
    } else {
      ui.recInfo.textContent = Recorder.events.length
        ? fmtMs(Recorder.duration()) + ' · ' + Recorder.noteCount() + ' 音符'
        : '尚未录音';
    }
  }

  ui.recToggle.addEventListener('click', function () {
    if (Recorder.recording) { Recorder.stop(); }
    else {
      if (AutoPlayer.playing) AutoPlayer.stop(), refreshAutoUI();
      Recorder.start();
      toast('开始录音，弹吧！', true);
    }
    refreshRecorderUI();
  });
  ui.recPlay.addEventListener('click', function () {
    if (Recorder.playing) return;
    var ok = Recorder.play(systemNoteOn, systemNoteOff, function (down) { AudioEngine.setPedal(down); }, function () {
      refreshRecorderUI();
      toast('回放结束');
    });
    refreshRecorderUI();
    if (ok) toast('回放中…', true);
  });
  ui.recStop.addEventListener('click', function () {
    Recorder.recording = false;
    Recorder.stopPlay();
    refreshRecorderUI();
  });
  ui.recClear.addEventListener('click', function () {
    Recorder.clear();
    refreshRecorderUI();
  });

  /* ---------------- 自动演奏面板 ---------------- */

  function refreshAutoUI() {
    var playing = AutoPlayer.playing;
    ui.autoToggle.textContent = playing ? '■ 停止' : '开 始';
    ui.autoToggle.classList.toggle('primary', true);
    if (!playing) {
      ui.autoInfo.textContent = AutoPlayer.mode === 'follow' ? '就绪 · 随便敲键盘' : '就绪';
    }
  }

  var autoInfoTimer = null;
  function updateAutoInfo() {
    if (!AutoPlayer.playing) { refreshAutoUI(); return; }
    if (AutoPlayer.mode === 'follow') {
      ui.autoInfo.textContent = '假弹中 ' + AutoPlayer.pointer + ' / ' + AutoPlayer.total;
    } else {
      ui.autoInfo.textContent = '演奏中 ' + Math.round(AutoPlayer.progress() * 100) + '%';
    }
  }

  ui.songSelect.innerHTML = '';
  window.SONGS.forEach(function (s) {
    var o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    ui.songSelect.appendChild(o);
  });

  ui.modeAuto.addEventListener('click', function () { setAutoMode('auto'); });
  ui.modeFollow.addEventListener('click', function () { setAutoMode('follow'); });
  function setAutoMode(m) {
    AutoPlayer.mode = m;
    ui.modeAuto.classList.toggle('on', m === 'auto');
    ui.modeFollow.classList.toggle('on', m === 'follow');
    refreshAutoUI();
  }

  ui.autoToggle.addEventListener('click', function () {
    if (AutoPlayer.playing) {
      AutoPlayer.stop();
      AudioEngine.allNotesOff(true);
      PianoUI.clearAllVisual();
      refreshAutoUI();
      return;
    }
    var song = null;
    for (var i = 0; i < window.SONGS.length; i++) {
      if (window.SONGS[i].id === ui.songSelect.value) song = window.SONGS[i];
    }
    if (!song) return;
    if (Recorder.recording) Recorder.stop(), refreshRecorderUI();
    AutoPlayer.start(song, AutoPlayer.mode, {
      noteOn: systemNoteOn,
      noteOff: systemNoteOff,
      onEnd: function () {
        refreshAutoUI();
        PianoUI.clearAllVisual();
        toast('《' + song.name + '》演奏结束 🎉');
      }
    });
    refreshAutoUI();
    toast(AutoPlayer.mode === 'follow'
      ? '假弹模式：随便敲键盘，乐曲会跟着你的节奏走！'
      : '正在演奏《' + song.name + '》', true);
  });

  /* ---------------- 顶栏 / 设置绑定 ---------------- */

  [ui.timbreSelect, ui.timbreSelect2].forEach(function (sel) {
    sel.addEventListener('change', function () {
      [ui.timbreSelect, ui.timbreSelect2].forEach(function (s2) { s2.value = sel.value; });
      loadTimbre(sel.value, false);
    });
  });

  function applyVolume() {
    AudioEngine.setMasterVolume(settings.volume / 100);
    ui.volVal.textContent = settings.volume;
    paintRange(ui.volumeSlider); paintRange(ui.volumeSlider2);
  }
  [ui.volumeSlider, ui.volumeSlider2].forEach(function (el) {
    el.addEventListener('input', function () {
      settings.volume = +el.value;
      [ui.volumeSlider, ui.volumeSlider2].forEach(function (o) { o.value = el.value; });
      applyVolume();
      saveSettings();
    });
  });

  function applyReverb() {
    AudioEngine.setReverb(settings.reverb / 100);
    ui.revVal.textContent = settings.reverb;
    paintRange(ui.reverbSlider);
  }
  ui.reverbSlider.addEventListener('input', function () {
    settings.reverb = +ui.reverbSlider.value;
    applyReverb();
    saveSettings();
  });

  ui.sustainLock.addEventListener('change', function () {
    settings.sustainLock = ui.sustainLock.checked;
    applyPedal();
    saveSettings();
  });

  ui.showKeys.addEventListener('change', function () {
    settings.showKeys = ui.showKeys.checked;
    PianoUI.updateLabels();
    saveSettings();
  });
  ui.showNotes.addEventListener('change', function () {
    settings.showNotes = ui.showNotes.checked;
    PianoUI.updateLabels();
    saveSettings();
  });
  ui.fxOn.addEventListener('change', function () {
    settings.fxOn = ui.fxOn.checked;
    FX.settings.enabled = settings.fxOn;
    saveSettings();
  });
  ui.fxIntensity.addEventListener('input', function () {
    settings.fxIntensity = +ui.fxIntensity.value;
    ui.fxVal.textContent = settings.fxIntensity;
    FX.settings.intensity = settings.fxIntensity / 100;
    paintRange(ui.fxIntensity);
    saveSettings();
  });

  ui.presetSelect.addEventListener('change', function () {
    KeyboardMap.setPreset(ui.presetSelect.value);
    settings.keyPreset = ui.presetSelect.value;
    saveSettings();
    ui.presetDesc.textContent = KeyboardMap.PRESETS[ui.presetSelect.value].desc;
    afterMappingChange();
  });
  ui.resetBinds.addEventListener('click', function () {
    KeyboardMap.reset();
    ui.presetSelect.value = KeyboardMap.state.preset;
    afterMappingChange();
    toast('键位已恢复默认');
  });

  function openDrawer() {
    ui.settingsDrawer.classList.add('open');
    ui.drawerMask.classList.add('show');
    renderBindList();
  }
  function closeDrawer() {
    ui.settingsDrawer.classList.remove('open');
    ui.drawerMask.classList.remove('show');
    bindListening = null;
  }
  ui.btnSettings.addEventListener('click', openDrawer);
  ui.settingsClose.addEventListener('click', closeDrawer);
  ui.drawerMask.addEventListener('click', closeDrawer);

  ui.btnRecorder.addEventListener('click', function () {
    ui.recorderPanel.classList.toggle('hidden');
    ui.autoPanel.classList.add('hidden');
    ui.btnRecorder.classList.toggle('active', !ui.recorderPanel.classList.contains('hidden'));
    ui.btnAutoplay.classList.remove('active');
    refreshRecorderUI();
  });
  ui.btnAutoplay.addEventListener('click', function () {
    ui.autoPanel.classList.toggle('hidden');
    ui.recorderPanel.classList.add('hidden');
    ui.btnAutoplay.classList.toggle('active', !ui.autoPanel.classList.contains('hidden'));
    ui.btnRecorder.classList.remove('active');
    refreshAutoUI();
  });

  /* ---------------- 欢迎页 ---------------- */

  ui.startBtn.addEventListener('click', function () {
    AudioEngine.ensureStarted();
    ui.welcome.classList.add('gone');
    started = true;
    loadTimbre(settings.timbre, false);
  });

  /* ---------------- Web MIDI 键盘（Chrome/Edge，插上即用） ---------------- */

  function initMidi() {
    if (!navigator.requestMIDIAccess) return;
    navigator.requestMIDIAccess().then(function (access) {
      var bound = 0;

      function bindInputs() {
        bound = 0;
        access.inputs.forEach(function (input) {
          bound++;
          input.onmidimessage = function (msg) {
            if (!started) return;
            var status = msg.data[0] & 0xf0;
            var d1 = msg.data[1], d2 = msg.data[2];
            if (status === 0x90 && d2 > 0) {
              userNoteOn(d1, Math.max(0.15, d2 / 127), 'midi');
            } else if (status === 0x80 || (status === 0x90 && d2 === 0)) {
              userNoteOff(d1, 'midi');
            } else if (status === 0xb0 && d1 === 64) {
              midiPedalDown = d2 >= 64;
              applyPedal();
            }
          };
        });
        if (bound > 0) {
          var names = [];
          access.inputs.forEach(function (i) { names.push(i.name); });
          toast('已连接 MIDI 设备：' + names.join('、'));
        }
      }

      bindInputs();
      access.onstatechange = function () { bindInputs(); };
    }).catch(function () { /* 用户拒绝 MIDI 权限则静默跳过 */ });
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    fillTimbreOptions();
    fillPresetOptions();
    // 键位方案以 keyboard-map 自身的持久化状态为准
    settings.keyPreset = KeyboardMap.state.preset;
    ui.presetDesc.textContent = KeyboardMap.PRESETS[KeyboardMap.state.preset].desc;

    PianoUI.build();
    PianoUI.bindPointer();
    FX.resize();
    window.addEventListener('resize', function () {
      FX.resize();
      updateOctaveHud();
    });

    // 应用持久化设置
    ui.showKeys.checked = settings.showKeys;
    ui.showNotes.checked = settings.showNotes;
    ui.fxOn.checked = settings.fxOn;
    FX.settings.enabled = settings.fxOn;
    ui.fxIntensity.value = settings.fxIntensity;
    ui.fxVal.textContent = settings.fxIntensity;
    FX.settings.intensity = settings.fxIntensity / 100;
    ui.volumeSlider.value = ui.volumeSlider2.value = settings.volume;
    ui.reverbSlider.value = settings.reverb;
    ui.sustainLock.checked = settings.sustainLock;
    paintRange(ui.volumeSlider); paintRange(ui.volumeSlider2);
    paintRange(ui.reverbSlider); paintRange(ui.fxIntensity);

    afterMappingChange();
    refreshRecorderUI();
    refreshAutoUI();

    // 面板信息刷新
    setInterval(function () {
      if (Recorder.recording || Recorder.playing) refreshRecorderUI();
      if (AutoPlayer.playing) updateAutoInfo();
    }, 150);

    initMidi();
  }

  init();
})();
