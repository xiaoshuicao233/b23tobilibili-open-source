var checkedIndices = new Set();
var results = [];

// ============================================================
// 主题切换
// ============================================================
function changeTheme(theme) {
    if (theme === 'auto') {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            document.documentElement.setAttribute('data-theme', 'dark');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
    } else if (theme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
    localStorage.setItem('theme', theme);
}

var savedTheme = localStorage.getItem('theme') || 'auto';
document.getElementById('themeSelect').value = savedTheme;
changeTheme(savedTheme);

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
    if (document.getElementById('themeSelect').value === 'auto') {
        changeTheme('auto');
    }
});

// ============================================================
// 事件绑定（无内联 onclick/onchange，符合 CSP script-src 'self'）
// ============================================================
document.getElementById('themeSelect').addEventListener('change', function() {
    changeTheme(this.value);
});
document.getElementById('convertBtn').addEventListener('click', function() { convertUrl(); });
document.getElementById('copySelectedBtn').addEventListener('click', function() { copyResult('selected'); });
document.getElementById('copyAllBtn').addEventListener('click', function() { copyResult('all'); });
document.getElementById('clearBtn').addEventListener('click', clearResults);

// 结果区域事件委托
document.getElementById('resultContent').addEventListener('click', function(e) {
    var checkAll = e.target.closest('#checkAll');
    if (checkAll) {
        toggleCheckAll(checkAll.checked);
        return;
    }
    var checkbox = e.target.closest('input[type="checkbox"][data-index]');
    if (checkbox) {
        e.stopPropagation();
        toggleCheck(parseInt(checkbox.getAttribute('data-index'), 10));
        return;
    }
    var row = e.target.closest('.result-item[data-index]');
    if (row && e.target.type !== 'checkbox') {
        toggleCheck(parseInt(row.getAttribute('data-index'), 10));
    }
});

document.addEventListener('dblclick', function(e) {
    if (e.target.closest('.result-box')) {
        var range = document.createRange();
        range.selectNodeContents(e.target.closest('.result-box'));
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }
});

// ============================================================
// 核心逻辑
// ============================================================
function escapeHtml(text) {
    var d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

function showError(msg) {
    var el = document.getElementById('error');
    el.textContent = msg;
    el.style.display = 'block';
}

async function convertUrl() {
    var input = document.getElementById('urlInput').value.trim();
    var convertBtn = document.getElementById('convertBtn');
    var loading = document.getElementById('loading');
    var error = document.getElementById('error');
    var result = document.getElementById('result');
    var resultContent = document.getElementById('resultContent');
    var stats = document.getElementById('stats');
    var progressBar = document.getElementById('progressBar');
    var progressFill = document.getElementById('progressFill');

    var lines = input.split('\n');
    var urls = [];
    for (var li = 0; li < lines.length; li++) {
        var urlMatches = lines[li].match(/(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}[A-Za-z0-9\-_.~:/?#[\]@!$&'()*+,;=%]*/g);
        if (urlMatches) {
            for (var mi = 0; mi < urlMatches.length; mi++) {
                var rawUrl = urlMatches[mi];
                rawUrl = rawUrl.replace(/[.,;!?，。！？、'""']+$/, '');
                if (rawUrl.includes('b23.tv/')) {
                    var shortMatch = rawUrl.match(/(?:https?:\/\/)?(?:www\.)?b23\.tv\/[A-Za-z0-9]+/);
                    if (shortMatch) rawUrl = shortMatch[0];
                }
                if (!/^https?:\/\//i.test(rawUrl)) rawUrl = 'https://' + rawUrl;
                // Fix 10: 前端预过滤，只保留 b23.tv / bilibili.com
                if (/b23\.tv|bilibili\.com/i.test(rawUrl)) urls.push(rawUrl);
            }
        }
    }

    if (urls.length === 0) { showError('请输入有效的 B 站链接（b23.tv 或 bilibili.com）'); return; }
    if (urls.length > 50) { showError('单次最多支持 50 条链接，当前 ' + urls.length + ' 条'); return; }

    error.style.display = 'none';
    result.style.display = 'none';
    resultContent.innerHTML = '';
    stats.textContent = '';
    stats.style.display = 'none';
    checkedIndices = new Set();
    results = new Array(urls.length).fill(null);
    loading.style.display = 'block';
    progressBar.style.display = 'block';
    progressFill.style.width = '0%';
    convertBtn.disabled = true;
    document.getElementById('urlInput').disabled = true;

    var successCount = 0, failCount = 0, completedCount = 0;

    async function processUrl(url, index) {
        var item;
        try {
            var resp = await fetch('/api/convert?url=' + encodeURIComponent(url));

            // Fix 11: 处理速率限制 429 响应，循环等待直到成功（最多重试 3 次）
            var retries = 0;
            while (resp.status === 429 && retries < 3) {
                var retryAfter = parseInt(resp.headers.get('Retry-After'), 10) || 5;
                await new Promise(function(r) { setTimeout(r, retryAfter * 1000); });
                resp = await fetch('/api/convert?url=' + encodeURIComponent(url));
                retries++;
            }

            var data = await resp.json();
            if (data.status === 'SUCCESS' || data.status === 'CLEANED') {
                item = { original: url, longUrl: data.longUrl, status: data.status, message: data.message, success: true };
                successCount++;
            } else {
                item = { original: url, longUrl: data.longUrl || '', status: data.status, message: data.message || '未知错误', success: false };
                failCount++;
            }
        } catch (err) {
            item = { original: url, longUrl: '', status: 'ERROR', message: '网络错误', success: false };
            failCount++;
        }
        results[index] = item;
        completedCount++;
        progressFill.style.width = ((completedCount / urls.length) * 100) + '%';
        stats.textContent = '进度: ' + completedCount + '/' + urls.length + ' (成功: ' + successCount + ', 失败: ' + failCount + ')';
        stats.style.display = 'block';
    }

    var idx = 0;
    // 并发数从 5 降至 2，减少对 b23.tv 的突发压力，降低风控风险
    var workers = Array(2).fill(Promise.resolve()).map(async function() {
        while (idx < urls.length) {
            var ci = idx++;
            await processUrl(urls[ci], ci);
            // 请求间隔 300ms，避免短时间内突发大量请求
            if (idx < urls.length) await new Promise(function(r) { setTimeout(r, 300); });
        }
    });
    await Promise.all(workers);

    renderResults();
    result.style.display = 'block';
    loading.style.display = 'none';
    progressBar.style.display = 'none';
    convertBtn.disabled = false;
    document.getElementById('urlInput').disabled = false;
}

function renderResults() {
    var rc = document.getElementById('resultContent');
    var stats = document.getElementById('stats');
    var allSuccess = results.filter(function(r) { return r && r.success; });
    var allChecked = allSuccess.length > 0 && allSuccess.every(function(r) { return checkedIndices.has(results.indexOf(r)); });

    var html = '<div class="result-header">' +
        '<input type="checkbox" id="checkAll" ' + (allChecked ? 'checked' : '') + ' title="全选成功条目">' +
        '<label for="checkAll" class="result-header-label">全选</label>' +
        '<span class="result-header-count">已勾选 ' + checkedIndices.size + ' 条</span></div>';

    for (var i = 0; i < results.length; i++) {
        var item = results[i];
        if (!item) continue;
        var isChecked = checkedIndices.has(i);
        var ic = 'result-item';
        var tc = 'result-long';
        if (item.status === 'SUCCESS' || item.status === 'CLEANED') { ic += ' success-item'; tc += ' success'; }
        else if (item.status === 'INVALID') { ic += ' warning-item'; tc += ' warning'; }
        else { ic += ' error-item'; tc += ' error'; }
        if (isChecked) ic += ' checked';
        var msg = item.message ? '<div class="result-message">' + escapeHtml(item.message) + '</div>' : '';
        var url = item.longUrl ? escapeHtml(item.longUrl) : '';
        var dis = !item.success ? 'disabled' : '';
        html += '<div class="' + ic + '" data-index="' + i + '">' +
            '<input type="checkbox" data-index="' + i + '" ' + (isChecked ? 'checked' : '') + ' ' + dis +
            ' title="' + (item.success ? '' : '失效或错误条目不可选') + '">' +
            '<div class="result-item-body"><div class="result-original">' + escapeHtml(item.original) + '</div>' +
            '<div class="' + tc + '">' + url + '</div>' + msg + '</div></div>';
    }
    rc.innerHTML = html;

    var sc = results.filter(function(r) { return r && r.success; }).length;
    var ivc = results.filter(function(r) { return r && r.status === 'INVALID'; }).length;
    var ec = results.filter(function(r) { return r && r.status === 'ERROR'; }).length;
    stats.textContent = '共 ' + results.length + ' 条：成功 ' + sc + '，失效 ' + ivc + '，错误 ' + ec;
    stats.style.display = 'block';
}

function toggleCheck(index) {
    if (!results[index] || !results[index].success) return;
    if (checkedIndices.has(index)) checkedIndices.delete(index);
    else checkedIndices.add(index);
    renderResults();
}

function toggleCheckAll(checked) {
    for (var i = 0; i < results.length; i++) {
        if (results[i] && results[i].success) {
            if (checked) checkedIndices.add(i); else checkedIndices.delete(i);
        }
    }
    renderResults();
}

function copyResult(mode) {
    var text = '';
    if (mode === 'selected') {
        text = Array.from(checkedIndices).sort(function(a, b) { return a - b; })
            .map(function(i) { return results[i]; })
            .filter(function(r) { return r && r.success; })
            .map(function(r) { return r.longUrl; }).join('\n');
    } else {
        text = results.filter(function(r) { return r && r.success; })
            .map(function(r) { return r.longUrl; }).join('\n');
    }
    if (!text) { alert(mode === 'selected' ? '请先勾选至少一条成功的结果' : '没有可复制的内容'); return; }

    var btn = mode === 'selected' ? document.getElementById('copySelectedBtn') : document.getElementById('copyAllBtn');
    var originalText = btn.textContent;
    navigator.clipboard.writeText(text).then(function() {
        btn.textContent = '已复制!';
        btn.classList.add('copied');
        setTimeout(function() { btn.textContent = originalText; btn.classList.remove('copied'); }, 2000);
    }).catch(function() { alert('复制失败，请手动复制'); });
}

function clearResults() {
    results = [];
    checkedIndices = new Set();
    document.getElementById('resultContent').innerHTML = '';
    document.getElementById('result').style.display = 'none';
    document.getElementById('stats').textContent = '';
    document.getElementById('stats').style.display = 'none';
    document.getElementById('urlInput').value = '';
}
