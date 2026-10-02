/**
 * 덱 보드 툴바. 생김새(버튼·드롭다운)는 가계도 style.css의 #toolbar / .toolbar-dropdown 규칙을
 * 그대로 쓴다. 버튼은 data-action → handlers[camelCase] 위임으로 처리한다.
 */
export class Toolbar {
  constructor(el, handlers = {}) {
    this.el = el;
    this.handlers = handlers;
    this._render();
  }

  _render() {
    this.el.innerHTML = `
      <div class="toolbar-group ui-mode-group" role="group" aria-label="수정/보기 모드">
        <button type="button" class="toggle" data-action="ui-mode" data-ui="edit" title="덱 내용 수정">수정</button>
        <button type="button" class="toggle" data-action="ui-mode" data-ui="view" title="수정용 버튼 없이 깔끔하게 보기">보기</button>
      </div>
      <div class="toolbar-group edit-only">
        <div class="toolbar-dropdown template-dropdown">
          <button type="button" data-action="template-menu" title="새 덱·리스트·저장한 템플릿 넣기">템플릿 ▾</button>
          <div class="toolbar-dropdown-menu template-menu-list"></div>
        </div>
        <div class="toolbar-dropdown relation-dropdown">
          <button type="button" class="toggle" data-action="relation-menu" title="덱끼리 관계선 긋기">관계 ▾</button>
          <div class="toolbar-dropdown-menu relation-menu-list"></div>
        </div>
      </div>
      <div class="toolbar-group view-mode-group" role="group" aria-label="표시 단계">
        <span class="view-mode-label">표시</span>
        <button type="button" class="toggle" data-action="view-mode" data-mode="full" title="전부 보기">많이</button>
        <button type="button" class="toggle" data-action="view-mode" data-mode="normal" title="장수·병종·전법만">보통</button>
        <button type="button" class="toggle" data-action="view-mode" data-mode="compact" title="장수만">적게</button>
      </div>
      <div class="toolbar-group toolbar-zoom-group">
        <button type="button" data-action="zoom-out" aria-label="축소">－</button>
        <button type="button" data-action="zoom-reset">100%</button>
        <button type="button" data-action="zoom-in" aria-label="확대">＋</button>
        <button type="button" data-action="fit" title="전체보기" aria-label="전체보기">⛶</button>
      </div>
      <div class="toolbar-group edit-only">
        <button type="button" data-action="undo" title="실행취소" aria-label="실행취소">↶</button>
        <button type="button" data-action="redo" title="다시실행" aria-label="다시실행">↷</button>
      </div>
      <div class="toolbar-group toolbar-group-right">
        <button type="button" data-action="theme-toggle" title="다크 모드 전환" aria-label="다크 모드 전환">🌙</button>
      </div>
      <div class="toolbar-group">
        <div class="toolbar-dropdown io-dropdown">
          <button type="button" data-action="io-menu" title="내보내기/가져오기" aria-label="내보내기/가져오기">💾</button>
          <div class="toolbar-dropdown-menu io-menu-list">
            <button type="button" data-io="export-board">보드 전체 JSON으로 내보내기</button>
            <button type="button" data-io="export-published" title="받은 파일을 리포지토리의 data/board.json에 덮어쓰고 push하면 게시돼요">게시용 board.json 저장</button>
            <button type="button" data-io="load-published" title="지금 보드를 게시된 data/board.json으로 바꾸기">게시본 불러오기</button>
            <label class="file-btn">가져오기(보드 또는 덱 JSON)<input type="file" accept="application/json" data-role="import"></label>
          </div>
        </div>
      </div>
      <span class="save-indicator" data-role="save-indicator">저장됨</span>
    `;

    this.el.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "template-menu") return this._toggle(".template-dropdown");
      if (action === "relation-menu") {
        // 연결 중에 다시 누르면 연결 취소(가계도 "&관계" 버튼과 같은 토글 규칙)
        if (this._connecting) return this.handlers.cancelConnect?.();
        return this._toggle(".relation-dropdown");
      }
      if (action === "io-menu") return this._toggle(".io-dropdown");
      if (action === "view-mode") return this.handlers.viewMode?.(btn.dataset.mode);
      if (action === "ui-mode") return this.handlers.uiMode?.(btn.dataset.ui);
      this.handlers[toCamel(action)]?.(e);
    });

    this.el.querySelector(".io-menu-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-io]");
      if (btn) {
        this.closeMenus();
        this.handlers[toCamel(btn.dataset.io)]?.();
      } else if (e.target.closest(".file-btn")) {
        this.closeMenus();
      }
    });

    this.el.querySelector('input[data-role="import"]').addEventListener("change", (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (file) this.handlers.import?.(file);
    });

    this.el.querySelector(".relation-menu-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-relation-template]");
      if (!btn) return;
      this.closeMenus();
      this.handlers.pickRelationTemplate?.(btn.dataset.relationTemplate);
    });

    this.el.querySelector(".template-menu-list").addEventListener("click", (e) => {
      const builtinBtn = e.target.closest("button[data-template-builtin]");
      const insertBtn = e.target.closest("button[data-template-insert]");
      const deleteBtn = e.target.closest("button[data-template-delete]");
      if (builtinBtn) {
        this.closeMenus();
        this.handlers.insertBuiltinTemplate?.(builtinBtn.dataset.templateBuiltin);
      } else if (insertBtn) {
        this.closeMenus();
        this.handlers.insertTemplate?.(insertBtn.dataset.templateInsert);
      } else if (deleteBtn) {
        this.handlers.deleteTemplate?.(deleteBtn.dataset.templateDelete);
      }
    });
    this.setTemplates([]);

    document.addEventListener("click", (e) => {
      for (const dd of this.el.querySelectorAll(".toolbar-dropdown.open")) {
        if (!dd.contains(e.target)) dd.classList.remove("open");
      }
    });
  }

  _toggle(selector) {
    const dropdown = this.el.querySelector(selector);
    const open = !dropdown.classList.contains("open");
    this.closeMenus();
    dropdown.classList.toggle("open", open);
  }

  closeMenus() {
    for (const dd of this.el.querySelectorAll(".toolbar-dropdown.open")) dd.classList.remove("open");
  }

  /** templates: DeckStore.listTemplates() — 이름은 사용자가 입력한 값이라 textContent로 넣는다.
   * 맨 위에는 항상 기본 템플릿(빈 덱 / 리스트)이 있고, 그 아래 구분선 다음에 저장한 템플릿들. */
  setTemplates(templates) {
    const menu = this.el.querySelector(".template-menu-list");
    menu.replaceChildren();
    const builtins = document.createElement("div");
    builtins.className = "template-menu-builtin";
    for (const [kind, label, title] of [
      ["deck", "🃏 덱 (장수 3명)", "화면 가운데에 빈 덱 넣기"],
      ["list", "📋 리스트 (시즌·장수·전법)", "화면 가운데에 빈 리스트 넣기"],
    ]) {
      const row = document.createElement("div");
      row.className = "template-menu-row";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.templateBuiltin = kind;
      btn.textContent = label;
      btn.title = title;
      row.append(btn);
      builtins.append(row);
    }
    menu.append(builtins);
    if (!templates.length) {
      const empty = document.createElement("p");
      empty.className = "template-menu-empty";
      empty.textContent = "저장된 템플릿이 없어요. 덱 오른쪽 위 ⋯ 메뉴에서 \"템플릿으로 저장\"을 눌러보세요.";
      menu.append(empty);
      return;
    }
    for (const t of templates) {
      const row = document.createElement("div");
      row.className = "template-menu-row";
      const insertBtn = document.createElement("button");
      insertBtn.type = "button";
      insertBtn.dataset.templateInsert = t.id;
      insertBtn.textContent = t.name;
      insertBtn.title = "화면 가운데에 넣기";
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "template-menu-delete";
      deleteBtn.dataset.templateDelete = t.id;
      deleteBtn.textContent = "×";
      deleteBtn.title = "템플릿 삭제";
      deleteBtn.setAttribute("aria-label", `${t.name} 템플릿 삭제`);
      row.append(insertBtn, deleteBtn);
      menu.append(row);
    }
  }

  setViewMode(mode) {
    for (const btn of this.el.querySelectorAll('[data-action="view-mode"]')) {
      btn.classList.toggle("active", btn.dataset.mode === mode);
      btn.setAttribute("aria-pressed", String(btn.dataset.mode === mode));
    }
  }

  /** 관계 템플릿 목록(catalog.relationTemplates)으로 "관계 ▾" 메뉴를 채운다. */
  setRelationTemplates(templates) {
    const menu = this.el.querySelector(".relation-menu-list");
    menu.replaceChildren(...templates.map((t) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.relationTemplate = t.id;
      const swatch = document.createElement("span");
      swatch.className = "relation-menu-swatch";
      swatch.style.borderTopStyle = t.lineStyle === "dashed" ? "dashed" : t.lineStyle === "dotted" ? "dotted" : "solid";
      if (t.color) swatch.style.borderTopColor = t.color;
      btn.append(swatch, document.createTextNode(`${t.name}${t.arrow ? " →" : ""}`));
      return btn;
    }));
  }

  /** text가 있으면 "관계" 버튼을 연결 중 상태로(강조 + 안내 문구), null이면 원래대로. */
  setConnectStatus(text) {
    this._connecting = !!text;
    const btn = this.el.querySelector('[data-action="relation-menu"]');
    btn.classList.toggle("active", !!text);
    btn.textContent = text || "관계 ▾";
  }

  setUiMode(mode) {
    for (const btn of this.el.querySelectorAll('[data-action="ui-mode"]')) {
      btn.classList.toggle("active", btn.dataset.ui === mode);
      btn.setAttribute("aria-pressed", String(btn.dataset.ui === mode));
    }
    if (mode === "view") this.closeMenus();
  }

  setSaveState(text) {
    this.el.querySelector('[data-role="save-indicator"]').textContent = text;
  }

  setThemeIcon(isDark) {
    this.el.querySelector('[data-action="theme-toggle"]').textContent = isDark ? "☀️" : "🌙";
  }
}

function toCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
