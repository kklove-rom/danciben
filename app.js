// ── LOCAL PERSISTENCE (多级存储：localStorage → cookie → 内存) ──
var STORE_KEY = 'yuanbao_wordbook_v1';
var memStore = {};           // 最终兜底：内存（刷新仍会丢，仅保证不报错）
var storageMode = 'memory';  // 'local' | 'cookie' | 'memory'

// 探测哪种存储可用
(function detectStorage(){
  try {
    localStorage.setItem('__t', '1');
    localStorage.removeItem('__t');
    storageMode = 'local';
    return;
  } catch(e) {}
  try {
    document.cookie = '__t=1;path=/';
    if (document.cookie.indexOf('__t=1') > -1) {
      storageMode = 'cookie';
      return;
    }
  } catch(e) {}
  storageMode = 'memory';
})();

function rawSet(k, v) {
  if (storageMode === 'local') { localStorage.setItem(k, v); return true; }
  if (storageMode === 'cookie') {
    // cookie 约 4KB 限制，超大数据自动降级为内存
    if (v.length > 3500) { storageMode = 'memory'; memStore[k] = v; return false; }
    document.cookie = k + '=' + encodeURIComponent(v) + ';path=/;max-age=31536000';
    return true;
  }
  memStore[k] = v;
  return false;
}

function rawGet(k) {
  if (storageMode === 'local') return localStorage.getItem(k);
  if (storageMode === 'cookie') {
    var m = document.cookie.match(new RegExp('(?:^|; )' + k + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  return memStore[k] || null;
}

function saveData() {
  try {
    var data = {
      books: books.map(function(b){ return {id:b.id, name:b.name, words:b.words}; }),
      settings: {
        content: document.getElementById('ss-content').value,
        repeat: document.getElementById('ss-repeat').value,
        interval: document.getElementById('ss-interval').value
      }
    };
    rawSet(STORE_KEY, JSON.stringify(data));
  } catch(e) {}
}

function loadData() {
  try {
    var raw = rawGet(STORE_KEY);
    if (!raw) return;
    var data = JSON.parse(raw);
    if (Array.isArray(data.books) && data.books.length) {
      books = data.books.map(function(b){
        return {
          id: b.id != null ? b.id : Date.now(),
          name: String(b.name || '未命名词书'),
          words: Array.isArray(b.words) ? b.words.map(function(w){
            return {word: String(w.word||''), pos: String(w.pos||''), def: String(w.def||'')};
          }).filter(function(w){ return w.word; }) : []
        };
      });
    }
    if (data.settings) {
      if (data.settings.content) document.getElementById('ss-content').value = data.settings.content;
      if (data.settings.repeat) document.getElementById('ss-repeat').value = data.settings.repeat;
      if (data.settings.interval) document.getElementById('ss-interval').value = data.settings.interval;
    }
  } catch(e) {}
}

// 数据变化时调用（新建/重命名/导入/设置）
function _persist(){ saveData(); }

// ── STATE ──
var books = [];
var curBook = null;
var renameTarget = null;
var defsVisible = true;

// ── AUDIO ENGINE (在线TTS，重写) ──
// 核心设计：
// 1. 单一 Audio 对象，顺序播放
// 2. 队列失效机制（generation token）
// 3. 自动重试（最多2次）
// 4. 英文 → 有道TTS，中文 → 有道TTS（统一用有道，稳定可靠）

var audioGen = 0;        // 队列代际号，每次新播放+1，停止时+1使旧队列失效
var audioQueue = [];     // 当前待播放URL队列
var audioIdx = 0;        // 当前播放索引
var isPlaying = false;
var isPaused = false;
var playSpeed = 0.75;
var playerActive = false;
var playerPaused = false;
var playIdx = 0;
var playerWords = [];
var playTimeout = null;

// 唯一的 Audio 对象
var audioEl = new Audio();
audioEl.preload = 'auto';

audioEl.addEventListener('ended', onAudioEnded);
audioEl.addEventListener('error', onAudioError);

var curRetry = 0;
var maxRetry = 1; // 第一次失败后重试1次

function getTTSUrl(text, lang) {
  // 英文单词 → 有道词典 dictvoice（type=2 美音，真人发音，最可靠）
  // 中文释义 → 有道翻译 fanyivoice（le=zh，专门支持中文，免费无需Key）
  // 注意：dictvoice 的 type 只支持英文音标，中文传 type=2 会返回静音，所以中文必须走 fanyivoice
  if (lang === 'zh') {
    return 'https://tts.youdao.com/fanyivoice?word=' + encodeURIComponent(text) + '&le=zh';
  }
  return 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(text) + '&type=2';
}

// 判断文本主要语言
function detectLang(text) {
  var hasEnglish = /[a-zA-Z]/.test(text);
  var hasChinese = /[一-鿿]/.test(text); // 等同 /[\u4e00-\u9fff]/
  if (hasEnglish && !hasChinese) return 'en';
  if (hasChinese) return 'zh';
  return 'en'; // 默认英文
}

// 播放单个URL，带重试
function playOneUrl(url, gen) {
  if (gen !== audioGen) return; // 队列已失效
  if (curRetry > maxRetry) {
    // 超过重试次数，跳过
    curRetry = 0;
    audioIdx++;
    scheduleNext(gen);
    return;
  }

  try {
    audioEl.src = url;
    audioEl.play().then(function() {
      if (gen !== audioGen) return;
      isPlaying = true;
    }).catch(function(err) {
      if (gen !== audioGen) return;
      // 播放失败，自动重试
      curRetry++;
      setTimeout(function() {
        if (gen !== audioGen) return;
        playOneUrl(url, gen);
      }, 300);
    });
  } catch(e) {
    // 异常也重试
    curRetry++;
    setTimeout(function() {
      if (gen !== audioGen) return;
      playOneUrl(url, gen);
    }, 300);
  }
}

function onAudioEnded() {
  var gen = audioGen;
  if (gen !== audioGen) return;
  curRetry = 0;
  audioIdx++;
  scheduleNext(gen);
}

function onAudioError() {
  var gen = audioGen;
  if (gen !== audioGen) return;
  curRetry++;
  if (curRetry <= maxRetry) {
    // 重试当前URL
    var url = audioQueue[audioIdx];
    if (url && gen === audioGen) {
      setTimeout(function() {
        if (gen === audioGen) playOneUrl(url, gen);
      }, 300);
    }
  } else {
    // 跳过
    curRetry = 0;
    audioIdx++;
    scheduleNext(gen);
  }
}

function scheduleNext(gen) {
  if (gen !== audioGen) return; // 队列失效，直接退出
  if (audioIdx >= audioQueue.length) {
    // 队列播完
    onQueueComplete();
    return;
  }
  var url = audioQueue[audioIdx];
  if (!url) {
    audioIdx++;
    scheduleNext(gen);
    return;
  }
  curRetry = 0;
  playOneUrl(url, gen);
}

function onQueueComplete() {
  isPlaying = false;
  // 通知外部（播放器模式）
  if (playerActive && playerCallback) {
    playerCallback();
  }
}

var playerCallback = null; // 播放完一个单词所有内容后的回调

// 播放一个单词（点击时调用）
function speakWord(w) {
  // 立即停止之前的队列，创建新队列
  stopAllAudio();
  var gen = audioGen; // 当前代际号（stopAllAudio 已递增）

  var content = document.getElementById('ss-content').value;
  var urls = [];

  // 英文单词发音
  urls.push(getTTSUrl(w.word, 'en'));

  if (content.indexOf('pos') > -1 && w.pos) {
    // 词性用中文读
    urls.push(getTTSUrl(w.pos.replace(/\./g, ''), 'zh'));
  }
  if (content.indexOf('def') > -1 && w.def) {
    urls.push(getTTSUrl(w.def, 'zh'));
  }

  audioQueue = urls;
  audioIdx = 0;
  curRetry = 0;

  scheduleNext(gen);
}

// 播放一个单词的全部内容（播放器模式）
function speakWordForPlayer(w, done) {
  var gen = audioGen;
  var content = document.getElementById('ss-content').value;
  var repeat = parseInt(document.getElementById('ss-repeat').value) || 1;
  var urls = [];

  for (var r = 0; r < repeat; r++) {
    urls.push(getTTSUrl(w.word, 'en'));
    if (content.indexOf('pos') > -1 && w.pos) {
      urls.push(getTTSUrl(w.pos.replace(/\./g, ''), 'zh'));
    }
    if (content.indexOf('def') > -1 && w.def) {
      urls.push(getTTSUrl(w.def, 'zh'));
    }
  }

  if (urls.length === 0) {
    done();
    return;
  }

  // 替换当前队列
  audioQueue = urls;
  audioIdx = 0;
  curRetry = 0;
  playerCallback = function() {
    playerCallback = null;
    if (gen === audioGen) done();
  };

  scheduleNext(gen);
}

function stopAllAudio() {
  // 使所有旧队列立即失效
  audioGen++;
  try {
    audioEl.pause();
    audioEl.currentTime = 0;
  } catch(e) {}
  isPlaying = false;
  curRetry = 0;
  clearTimeout(playTimeout);
}

// ── PLAYER (播放器模式) ──
function togglePlayer() {
  if (playerActive) { stopPlayer(); return; }
  if (!curBook || !curBook.words.length) return;

  playerWords = curBook.words.slice();
  playIdx = 0;
  playerActive = true;
  playerPaused = false;
  document.getElementById('player-bar').classList.remove('hide');
  document.getElementById('btn-play').querySelector('i').className = 'ti ti-player-stop';
  document.getElementById('pl-icon').className = 'ti ti-player-pause';
  playNextWord();
}

function stopPlayer() {
  playerActive = false;
  playerPaused = false;
  stopAllAudio();
  document.getElementById('player-bar').classList.add('hide');
  document.getElementById('btn-play').querySelector('i').className = 'ti ti-player-play';
  document.getElementById('prog-fill').style.width = '0%';
  document.getElementById('pl-info').textContent = '准备播放...';
}

function playerPP() {
  if (!playerActive) return;
  if (playerPaused) {
    // 恢复
    playerPaused = false;
    document.getElementById('pl-icon').className = 'ti ti-player-pause';
    if (isPlaying === false && audioIdx < audioQueue.length) {
      // 被暂停了，重新播放当前
      var gen = audioGen;
      scheduleNext(gen);
    } else {
      audioEl.play().catch(function(){});
    }
  } else {
    // 暂停
    playerPaused = true;
    document.getElementById('pl-icon').className = 'ti ti-player-play';
    audioEl.pause();
  }
}

function playNextWord() {
  if (!playerActive) return;
  if (playIdx >= playerWords.length) { stopPlayer(); return; }

  var w = playerWords[playIdx];
  var pct = Math.round((playIdx / playerWords.length) * 100);
  document.getElementById('prog-fill').style.width = pct + '%';
  document.getElementById('pl-info').textContent = (playIdx + 1) + '/' + playerWords.length + ' — ' + w.word;

  speakWordForPlayer(w, function() {
    if (!playerActive) return;
    playIdx++;
    var interval = parseFloat(document.getElementById('ss-interval').value) || 1;
    playTimeout = setTimeout(playNextWord, interval * 1000);
  });
}

function setSpeed(s, el) {
  playSpeed = s;
  document.querySelectorAll('.speed-btn').forEach(function(b) { b.classList.remove('on'); });
  el.classList.add('on');
}

function seekProg(e) {
  var rect = document.getElementById('prog-wrap').getBoundingClientRect();
  var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  playIdx = Math.floor(pct * playerWords.length);
  stopAllAudio();
  clearTimeout(playTimeout);
  if (playerActive) playNextWord();
}

// ── NAVIGATION (只有学习界面) ──
function go(id) {
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.add('hidden'); });
  document.getElementById(id).classList.remove('hidden');
}

function backToShelf() { stopPlayer(); go('s-shelf'); renderShelf(); }

// ── SHELF ──
var bookColors = [
  ['#e0d8ff','#a89af0','#6d5cd9'],
  ['#ffd8b0','#f0a060','#d97030'],
  ['#c8f0d8','#70c890','#2d9050'],
  ['#ffd0e8','#f080b0','#c04080'],
  ['#c8e8ff','#6db8f0','#1a70c0'],
];

function renderShelf() {
  var g = document.getElementById('shelf-grid');
  g.innerHTML = '';
  books.forEach(function(b, i) {
    var c = bookColors[i % bookColors.length];
    var card = document.createElement('div');
    card.className = 'book-card';
    card.innerHTML =
      '<div class="book-spine" style="background:linear-gradient(160deg,'+c[0]+','+c[1]+');box-shadow:4px 4px 0 '+c[2]+'40">' +
        '<i class="ti ti-book-2" style="color:'+c[2]+';font-size:28px"></i>' +
      '</div>' +
      '<div class="book-name">'+esc(b.name)+'</div>' +
      '<div class="book-count">'+b.words.length+' 个单词</div>';

    // ── 长按词书弹出操作菜单（500ms，移动超过10px取消）──
    var lpTimer = null;   // 长按计时器
    var lpFired = false;  // 本次按压是否已触发长按（用于吞掉随后的click）
    var lpX = 0, lpY = 0; // 按压起点坐标

    function lpStart(e) {
      lpFired = false;
      var t = e.touches ? e.touches[0] : e;
      lpX = t.clientX; lpY = t.clientY;
      lpTimer = setTimeout(function() {
        lpTimer = null;
        lpFired = true;
        openBookMenu(b);
      }, 500);
    }
    function lpMove(e) {
      if (!lpTimer) return;
      var t = e.touches ? e.touches[0] : e;
      if (Math.abs(t.clientX - lpX) > 10 || Math.abs(t.clientY - lpY) > 10) {
        clearTimeout(lpTimer); lpTimer = null;
      }
    }
    function lpEnd() {
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
    }
    card.addEventListener('touchstart', lpStart, {passive:true});
    card.addEventListener('touchmove', lpMove, {passive:true});
    card.addEventListener('touchend', lpEnd);
    card.addEventListener('touchcancel', lpEnd);
    card.addEventListener('mousedown', lpStart);
    card.addEventListener('mousemove', lpMove);
    card.addEventListener('mouseup', lpEnd);
    card.addEventListener('mouseleave', lpEnd);
    // 屏蔽浏览器默认右键/长按菜单，避免与自定义菜单冲突
    card.addEventListener('contextmenu', function(e) { e.preventDefault(); });

    card.querySelector('.book-name').addEventListener('click', function(e) {
      e.stopPropagation();
      if (lpFired) { lpFired = false; return; } // 长按后不触发重命名
      openRename(b);
    });
    card.addEventListener('click', function() {
      if (lpFired) { lpFired = false; return; } // 长按后不进入词书
      openBook(b);
    });
    g.appendChild(card);
  });
  var add = document.createElement('div');
  add.className = 'add-book-card';
  add.innerHTML = '<i class="ti ti-plus"></i><span>新建词书</span>';
  add.onclick = createBook;
  g.appendChild(add);
}

function openBook(b) {
  curBook = b;
  document.getElementById('wl-title').textContent = b.name;
  renderWordList();
  go('s-wordlist');
}

function renderWordList() {
  var el = document.getElementById('word-scroll');
  if (!curBook || curBook.words.length === 0) {
    el.innerHTML = '<div class="empty-hint"><div class="ei-icon">📚</div><div class="ei-text">快导入词书进行学习吧(≧ω≦)/<br><br>支持 .txt 文件导入<br>格式：单词 词性 释义</div></div>';
    return;
  }
  el.innerHTML = '';
  curBook.words.forEach(function(w) {
    var d = document.createElement('div');
    d.className = 'word-item';
    d.innerHTML = '<div class="w-word">'+esc(w.word)+'</div><div class="w-def'+(defsVisible?'':' hide')+'"><span class="pos">'+esc(w.pos||'')+'</span>'+esc(w.def||'')+'</div>';
    d.addEventListener('click', function() { speakWord(w); });
    el.appendChild(d);
  });
}

function toggleDefs() {
  defsVisible = !defsVisible;
  document.querySelectorAll('.w-def').forEach(function(el) { el.classList.toggle('hide', !defsVisible); });
  document.getElementById('btn-eye').querySelector('i').className = defsVisible ? 'ti ti-eye' : 'ti ti-eye-off';
}

// ── IMPORT ──
function importFile(inp) {
  var file = inp.files[0]; if (!file) return;
  var ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'txt' || ext === 'csv') {
    var r = new FileReader();
    r.onload = function(e) { parseTxt(e.target.result); };
    r.readAsText(file, 'UTF-8');
  } else {
    alert('暂仅支持 .txt 文件\n格式示例：\napple n. 苹果');
  }
  inp.value = '';
}

function parseTxt(text) {
  var lines = text.split('\n').filter(function(l) { return l.trim(); });
  var words = [];
  lines.forEach(function(line) {
    line = line.trim(); if (!line) return;
    // 尝试匹配: word pos def
    var m = line.match(/^(.+?)\s+(n\.|v\.|adj\.|adv\.|prep\.|conj\.|pron\.|int\.|art\.|num\.|vt\.|vi\.|abbr\.)\s+(.+)$/);
    if (m) {
      words.push({word: m[1].trim(), pos: m[2].trim(), def: m[3].trim()});
    } else {
      // 简单分割：第一个空格前是单词
      var idx = line.search(/\s+/);
      if (idx > 0) {
        words.push({word: line.slice(0, idx), pos: '', def: line.slice(idx).trim()});
      } else {
        words.push({word: line, pos: '', def: ''});
      }
    }
  });
  if (words.length) addWords(words);
  else alert('未能解析出单词，请检查文件格式');
}

function addWords(ws) {
  if (!curBook) return;
  curBook.words = curBook.words.concat(ws);
  saveData();
  renderWordList();
  renderShelf();
}

// ── BOOK MODALS ──
function createBook() {
  document.getElementById('newbook-input').value = '';
  openModal('modal-newbook');
  setTimeout(function() { document.getElementById('newbook-input').focus(); }, 50);
}
function confirmNewBook() {
  var n = document.getElementById('newbook-input').value.trim();
  if (!n) return;
  books.push({id: Date.now(), name: n, words: []});
  saveData();
  closeModal('modal-newbook'); renderShelf();
}
function openRename(b) {
  renameTarget = b;
  document.getElementById('rename-input').value = b.name;
  openModal('modal-rename');
  setTimeout(function() { document.getElementById('rename-input').focus(); }, 50);
}
function confirmRename() {
  var n = document.getElementById('rename-input').value.trim();
  if (!n || !renameTarget) return;
  renameTarget.name = n;
  saveData();
  closeModal('modal-rename');
  if (curBook && curBook.id === renameTarget.id) document.getElementById('wl-title').textContent = n;
  renderShelf();
}

// ── 词书操作菜单（长按弹出） ──
var menuTarget = null; // 当前菜单指向的词书

function openBookMenu(b) {
  menuTarget = b;
  document.getElementById('menu-book-name').textContent = b.name;
  openModal('modal-bookmenu');
}
function closeBookMenu() {
  closeModal('modal-bookmenu');
  menuTarget = null;
}
function deleteMenuBook() {
  if (!menuTarget) return;
  var target = menuTarget;
  closeBookMenu();
  books = books.filter(function(b) { return b.id !== target.id; });
  if (curBook && curBook.id === target.id) curBook = null;
  saveData();
  renderShelf();
}

function openModal(id) { document.getElementById(id).classList.remove('hide'); }
function closeModal(id) { document.getElementById(id).classList.add('hide'); }
document.querySelectorAll('.overlay').forEach(function(o) {
  o.addEventListener('click', function(e) { if (e.target === o) o.classList.add('hide'); });
});

// ── SETTINGS (仅发音测试) ──
function openSettings() {
  openModal('modal-settings');
  document.getElementById('test-result').textContent = '';
  document.getElementById('test-result').className = 'test-result';
  var st = document.getElementById('storage-status');
  if (storageMode === 'local') {
    st.textContent = '✓ 数据已启用本地持久保存（localStorage）';
    st.style.color = '#34c759';
  } else if (storageMode === 'cookie') {
    st.textContent = '⚠ localStorage 被禁用，已降级为 Cookie 保存';
    st.style.color = '#ff9500';
  } else {
    st.textContent = '✗ 当前环境禁止本地存储，刷新后数据会丢失';
    st.style.color = '#ff3b30';
  }
}

function onEngineChange() {
  // 预留接口，目前只有在线模式
}

// 设置项变化时自动保存
document.getElementById('ss-content').addEventListener('change', saveData);
document.getElementById('ss-repeat').addEventListener('change', saveData);
document.getElementById('ss-interval').addEventListener('change', saveData);

// 测试发音 — 验证网络通道是否通畅
function testAudio() {
  var btn = document.getElementById('test-audio-btn');
  var result = document.getElementById('test-result');
  btn.classList.add('testing');
  btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i> 测试中...';
  result.textContent = '正在通过有道TTS测试英文发音...';
  result.className = 'test-result';

  // 加一个旋转动画
  if (!document.getElementById('spin-style')) {
    var style = document.createElement('style');
    style.id = 'spin-style';
    style.textContent = '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
  }

  var testGen = audioGen + 1; // 不干扰当前播放

  // 测试英文：有道TTS
  var enUrl = getTTSUrl('hello', 'en');
  var enAudio = new Audio();
  enAudio.src = enUrl;

  var enOk = false;
  var zhOk = false;
  var finished = 0;

  function checkDone() {
    finished++;
    if (finished >= 2) {
      btn.classList.remove('testing');
      if (enOk && zhOk) {
        btn.innerHTML = '<i class="ti ti-volume"></i> 测试发音';
        result.textContent = '✓ 英文 + 中文 通道均正常（有道TTS）';
        result.className = 'test-result ok';
      } else if (enOk) {
        btn.innerHTML = '<i class="ti ti-volume"></i> 测试发音';
        result.textContent = '⚠ 英文通道正常，中文通道可能受限（单词仍可正常发音）';
        result.className = 'test-result ok';
      } else {
        btn.innerHTML = '<i class="ti ti-volume"></i> 测试发音';
        result.textContent = '✗ 网络通道异常，请检查网络连接';
        result.className = 'test-result fail';
      }
    }
  }

  // 测试英文
  enAudio.addEventListener('canplay', function() { enOk = true; });
  enAudio.addEventListener('loadeddata', function() { enOk = true; });
  enAudio.addEventListener('playing', function() { enOk = true; });
  enAudio.addEventListener('error', function() {});
  enAudio.addEventListener('ended', function() { enOk = true; checkDone(); });

  enAudio.play().then(function() {
    enOk = true;
    // 播放成功后再测中文
    setTimeout(function() {
      result.textContent = '英文通道OK，正在测试中文(有道TTS)...';
      var zhUrl = getTTSUrl('测试', 'zh');
      var zhAudio = new Audio();
      zhAudio.src = zhUrl;
      zhAudio.addEventListener('canplay', function() { zhOk = true; });
      zhAudio.addEventListener('loadeddata', function() { zhOk = true; });
      zhAudio.addEventListener('playing', function() { zhOk = true; });
      zhAudio.addEventListener('error', function() {});
      zhAudio.addEventListener('ended', function() { zhOk = true; checkDone(); });
      zhAudio.play().then(function() {
        zhOk = true;
        setTimeout(checkDone, 1500);
      }).catch(function() {
        // 有道TTS可能CORS限制，但如果有声音也算OK
        setTimeout(function() {
          // 即使play promise reject，浏览器也可能已经发出声音
          checkDone();
        }, 2000);
      });
      setTimeout(checkDone, 4000); // 总超时4秒
    }, 500);
  }).catch(function() {
    // 英文也失败
    setTimeout(function() {
      // 直接测中文
      result.textContent = '正在尝试中文通道...';
      var zhUrl2 = getTTSUrl('测试', 'zh');
      var zhAudio2 = new Audio();
      zhAudio2.src = zhUrl2;
      zhAudio2.addEventListener('playing', function() { zhOk = true; });
      zhAudio2.addEventListener('error', function() {});
      zhAudio2.play().then(function() { zhOk = true; }).catch(function() {});
      setTimeout(function() {
        btn.classList.remove('testing');
        if (zhOk) {
          btn.innerHTML = '<i class="ti ti-volume"></i> 测试发音';
          result.textContent = '⚠ 英文通道受限，中文通道正常（单词可能只能读中文释义）';
          result.className = 'test-result ok';
        } else {
          btn.innerHTML = '<i class="ti ti-volume"></i> 测试发音';
          result.textContent = '✗ 网络通道异常，请检查网络连接';
          result.className = 'test-result fail';
        }
      }, 3000);
    }, 500);
  });

  // 总超时保护（8秒）
  setTimeout(function() {
    if (btn.classList.contains('testing')) {
      btn.classList.remove('testing');
      btn.innerHTML = '<i class="ti ti-volume"></i> 测试发音';
      if (enOk) {
        result.textContent = '✓ 英文(有道)通道正常，中文通道超时（英文单词可正常发音）';
        result.className = 'test-result ok';
      } else {
        result.textContent = '✗ 测试超时，请检查网络连接';
        result.className = 'test-result fail';
      }
    }
  }, 8000);
}

// ── UTIL ──
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── INIT ──
window.addEventListener('beforeunload', saveData);
document.addEventListener('visibilitychange', function(){ if (document.hidden) saveData(); });
loadData();
renderShelf();
