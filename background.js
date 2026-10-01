// ============================================================
// 配置区
//   真正的 API Key 放在 config.js 里，而 config.js 被 .gitignore 忽略，
//   所以公开仓库里不会出现任何私密信息。
//   importScripts 是 service worker 加载另一个 js 文件的方式：
//   它在当前全局作用域里执行那个文件，于是 self.TT_CONFIG 就能读到了。
//   注意：它只能在这个文件的最顶层同步调用，不能塞进函数里。
// ============================================================
try {
  importScripts("config.js");
} catch (e) {
  console.error(
    "[翻译器] 读不到 config.js。请把 config.example.js 复制成 config.js，" +
      "填上自己的 API Key，再到 chrome://extensions 重新加载本扩展。"
  );
}

const CFG = self.TT_CONFIG || {};
const api_key = CFG.api_key || "";
const model = CFG.model || "glm-4-flash";
const API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

// ============================================================
// 1. 安装扩展时注册右键菜单
// ============================================================
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "transText",
    title: "翻译选中的文本",
    contexts: ["selection"],
  });
});

// ============================================================
// 2. 右键菜单被点击 -> 走完整条翻译流程
// ============================================================
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "transText") return;

  const text = (info.selectionText || "").trim();
  if (!text) return; // 空选中直接忽略
  if (!tab || tab.id === undefined) return;

  // 没配 Key 时不要发请求（否则只能拿到一个看不懂的 401），直接在页面上说清楚
  if (!api_key) {
    await inject(tab.id, {
      state: "error",
      original: text,
      result:
        "还没配置 API Key。请把 config.example.js 复制成 config.js，" +
        "填入你的智谱 API Key，然后在 chrome://extensions 点「重新加载」。",
    });
    return;
  }

  try {
    // 2.1 先在页面里弹出「翻译中…」，让用户马上看到反馈（不然等接口的 1~2 秒像没反应）
    await inject(tab.id, { state: "loading", original: text });

    // 2.2 调模型接口
    const result = await callGLMAPI(text);

    // 2.3 再用译文替换掉加载框（display 每次执行都会先删掉旧的，所以不会越堆越多）
    await inject(tab.id, {
      state: result.indexOf("接口错误") === 0 ? "error" : "ok",
      original: text,
      result: result,
    });
  } catch (err) {
    // 典型场景：在 chrome:// 页面、扩展商店、PDF 阅读器里，executeScript 会被禁止
    console.error("[翻译器] 注入或请求失败：", err);
  }
});

// 把 display 函数塞进指定标签页执行的小封装
function inject(tabId, payload) {
  return chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: display,
    args: [payload],
  });
}

// ============================================================
// 3. 调用智谱 GLM 接口
//    注意：必须在这里（service worker）发请求，见后面讲解
// ============================================================
async function callGLMAPI(text) {
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + api_key,
    },
    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: "system",
          content:
            "你是翻译助手。把用户给的外文翻译成自然通顺的简体中文，只输出译文本身，" +
            "不要解释、不要加引号、不要重复原文。如果原文已经是中文，就原样返回。",
        },
        { role: "user", content: text },
      ],
      temperature: 0.2,
      stream: false,
    }),
  });

  // 先拿纯文本再自己解析：这样接口返回 HTML 错误页时不会直接抛异常
  const raw = await resp.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return "接口错误：返回的不是 JSON（HTTP " + resp.status + "）";
  }

  console.log("[翻译器] API 完整返回：", data);

  if (!resp.ok) {
    return (
      "接口错误：HTTP " +
      resp.status +
      " - " +
      ((data.error && data.error.message) || "请检查 Key、模型名或余额")
    );
  }

  if (data.choices && data.choices.length > 0) {
    const content = data.choices[0].message.content;
    return content ? content.trim() : "模型没有返回内容";
  }

  return "接口错误：" + ((data.error && data.error.message) || "未知错误");
}

// ============================================================
// 4. 注入到页面里的弹框
//    !! 这个函数会被「序列化」成字符串发到页面上重新执行，
//    所以它不能使用外部任何变量 / 常量 / 函数，必须完全自给自足。
//    接收一个对象 { state, original, result }
// ============================================================
function display(data) {
  var HOST_ID = "__tt_host";

  // 4.1 先清理上一次的结果（DOM + 拖动监听），避免重复翻译堆一屏
  var oldHost = document.getElementById(HOST_ID);
  if (oldHost) oldHost.remove();
  if (window.__ttCleanup) {
    try { window.__ttCleanup(); } catch (e) {}
    window.__ttCleanup = null;
  }

  var state = data.state || "ok";
  var original = data.original || "";
  var result = data.result || "";

  // 4.2 宿主容器：固定定位，z-index 开到最大
  var host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;";

  // 4.3 Shadow DOM：让弹框的样式和网页样式互不污染
  var root = host.attachShadow({ mode: "open" });

  var style = document.createElement("style");
  style.textContent = [
    '.tt-card{box-sizing:border-box;width:360px;max-width:92vw;background:#fff;color:#1f2328;',
    'border:1px solid #d0d7de;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);',
    'overflow:hidden;font-size:14px;line-height:1.6;',
    'font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;}',
    '.tt-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#f6f8fa;',
    'border-bottom:1px solid #d0d7de;cursor:move;user-select:none;}',
    '.tt-title{flex:1;font-weight:600;font-size:13px;color:#57606a;}',
    '.tt-btn{border:1px solid #d0d7de;background:#fff;color:#57606a;border-radius:6px;',
    'font-size:12px;padding:2px 8px;cursor:pointer;font-family:inherit;}',
    '.tt-btn:hover{background:#eaeef2;}',
    '.tt-btn[disabled]{opacity:.45;cursor:default;}',
    '.tt-close{padding:2px 7px;font-size:13px;line-height:1;}',
    '.tt-close:hover{background:#fcebeb;border-color:#f09595;color:#a32d2d;}',
    '.tt-body{max-height:52vh;overflow:auto;padding:10px 12px;}',
    '.tt-src{color:#8b949e;font-size:12px;border-bottom:1px dashed #e1e4e8;',
    'padding-bottom:8px;margin-bottom:8px;word-break:break-word;}',
    '.tt-out{white-space:pre-wrap;word-break:break-word;}',
    '.tt-err{color:#b42318;}',
    '.tt-loading{color:#8b949e;}',
  ].join("");

  // ---- 头部 ----
  var card = document.createElement("div");
  card.className = "tt-card";

  var head = document.createElement("div");
  head.className = "tt-head";

  var title = document.createElement("span");
  title.className = "tt-title";
  title.textContent = state === "loading" ? "AI 翻译 · 翻译中…" : "AI 翻译";

  var btnCopy = document.createElement("button");
  btnCopy.className = "tt-btn";
  btnCopy.textContent = "复制";
  if (state === "loading") btnCopy.disabled = true;

  var btnClose = document.createElement("button");
  btnClose.className = "tt-btn tt-close";
  btnClose.textContent = "✕";
  btnClose.title = "关闭（Esc）";
  btnClose.setAttribute("aria-label", "关闭");

  head.appendChild(title);
  head.appendChild(btnCopy);
  head.appendChild(btnClose);

  // ---- 正文 ----
  var body = document.createElement("div");
  body.className = "tt-body";

  if (original) {
    var src = document.createElement("div");
    src.className = "tt-src";
    src.textContent = original;
    body.appendChild(src);
  }

  var out = document.createElement("div");
  if (state === "loading") {
    out.className = "tt-out tt-loading";
    out.textContent = "正在请求模型…";
  } else {
    out.className = state === "error" ? "tt-out tt-err" : "tt-out";
    out.textContent = result; // 用 textContent 而不是 innerHTML，天然防注入
  }
  body.appendChild(out);

  card.appendChild(head);
  card.appendChild(body);
  root.appendChild(style);
  root.appendChild(card);

  // 4.4 恢复上次拖动到的位置（同一个标签页内有效）
  if (window.__ttPos) {
    host.style.left = window.__ttPos.left;
    host.style.top = window.__ttPos.top;
    host.style.right = "auto";
  }

  document.documentElement.appendChild(host);

  // 4.5 关闭：按钮和 Esc 键共用一个出口
  //     关闭要做两件事——摘掉挂在 window 上的监听，再把宿主节点从页面移除。
  //     只做一次（host.parentNode 判断），所以重复点、或者关了之后再按 Esc 都不会出错。
  function closeBox() {
    if (window.__ttCleanup) {
      try { window.__ttCleanup(); } catch (e) {}
      window.__ttCleanup = null;
    }
    if (host.parentNode) host.remove();
  }

  btnClose.addEventListener("click", closeBox);

  // Esc 也能关。用 capture 阶段监听，防止被页面自己的 stopPropagation 截住
  function onKeyDown(e) {
    if (e.key === "Escape") closeBox();
  }
  window.addEventListener("keydown", onKeyDown, true);

  // 4.6 复制（clipboard 可能因页面失焦而失败，所以留个 execCommand 兜底）
  function fallbackCopy(t) {
    var ta = document.createElement("textarea");
    ta.value = t;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    ta.remove();
  }

  btnCopy.addEventListener("click", function () {
    var content = out.textContent || "";
    var flash = function () {
      btnCopy.textContent = "已复制";
      setTimeout(function () { btnCopy.textContent = "复制"; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(content).then(flash, function () {
        fallbackCopy(content);
        flash();
      });
    } else {
      fallbackCopy(content);
      flash();
    }
  });

  // 4.7 拖动：按住标题栏移动整块（用 pointer capture，事件不会漏到网页上，
  //     也不用往 document 挂全局监听，所以没有内存泄漏）
  head.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    // 点在按钮上时不能开始拖动：按钮就在标题栏里，不拦住的话
    // 点「复制」「✕」都会顺带把指针捕获过去，手感很奇怪
    if (e.target.tagName === "BUTTON") return;
    head.setPointerCapture(e.pointerId);

    var rect = host.getBoundingClientRect();
    var baseX = rect.left, baseY = rect.top;
    var startX = e.clientX, startY = e.clientY;

    var onMove = function (ev) {
      var left = baseX + ev.clientX - startX;
      var top = baseY + ev.clientY - startY;
      host.style.left = left + "px";
      host.style.top = top + "px";
      host.style.right = "auto";
      window.__ttPos = { left: left + "px", top: top + "px" };
    };
    var onUp = function () {
      head.removeEventListener("pointermove", onMove);
      head.removeEventListener("pointerup", onUp);
    };

    head.addEventListener("pointermove", onMove);
    head.addEventListener("pointerup", onUp);
    e.preventDefault();
  });

  // 4.8 登记清理函数：下一次执行 display（重新翻译）时会先调用它，
  //     保证 window 上的 keydown 监听不会一次次累积
  window.__ttCleanup = function () {
    // 拖动用的 pointermove/pointerup 绑在 head 上，随 host 一起被删除就自动失效，
    // 这里只需要管挂在 window 上的那个
    window.removeEventListener("keydown", onKeyDown, true);
  };
}
