// ==UserScript==
// @name        Ctrl Tab Panel
// @description Runtime finish for Zen Browser PR #12397.
// @include     main
// ==/UserScript==

(() => {
  "use strict";

  const CONTROLLER_KEY = "__zenCtrlTabPanelMod";
  const PANEL_ID = "zen-ctrl-tab-panel";
  const CARDS_ID = "zen-ctrl-tab-panel-cards";
  const CARD_SELECTOR = ".zen-ctrl-tab-panel-card";
  const PREFS = {
    enabled: "zen.tabs.ctrl-tab-panel.enabled",
    sortByRecentlyUsed: "zen.tabs.ctrl-tab-panel.sort-by-recent",
    groupSplitView: "zen.tabs.ctrl-tab-panel.group-split-view",
  };

  if (window[CONTROLLER_KEY]) {
    window[CONTROLLER_KEY].destroy();
  }

  const getBoolPref = (pref, fallback) => {
    try {
      return Services.prefs.getBoolPref(pref, fallback);
    } catch (error) {
      return fallback;
    }
  };

  const setDefaultBoolPref = (pref, value) => {
    try {
      Services.prefs.getDefaultBranch("").setBoolPref(pref, value);
    } catch (error) {}
  };

  class ZenCtrlTabPanelMod {
    static CARD_WIDTH = 250;
    static CARD_HEIGHT = 220;
    static PANEL_PADDING = 16;
    static PANEL_HEIGHT =
      ZenCtrlTabPanelMod.CARD_HEIGHT + ZenCtrlTabPanelMod.PANEL_PADDING * 2;

    #isOpen = false;
    #currentIndex = 0;
    #tabList = [];
    #entryList = [];
    #thumbnailCache = new Map();
    #actualVisibleCards = undefined;
    #openGeneration = 0;
    #originalCtrlTabOpen = null;

    constructor(win) {
      this.window = win;
      this.document = win.document;
      this.onKeyDown = this.#handleKeyDown.bind(this);
      this.onKeyUp = this.#handleKeyUp.bind(this);
      this.onBlur = this.#handleBlur.bind(this);
      this.onTabClose = this.#handleTabClose.bind(this);
    }

    init() {
      setDefaultBoolPref(PREFS.enabled, true);
      setDefaultBoolPref(PREFS.sortByRecentlyUsed, false);
      setDefaultBoolPref(PREFS.groupSplitView, true);
      this.#installPanel();
      this.#patchFirefoxCtrlTab();
      this.window.addEventListener("keydown", this.onKeyDown, true);
      this.window.addEventListener("keyup", this.onKeyUp, true);
      this.window.addEventListener("blur", this.onBlur);
      this.window.addEventListener("TabClose", this.onTabClose);
      this.window.addEventListener("unload", () => this.destroy(), { once: true });
    }

    get panel() {
      return this.document.getElementById(PANEL_ID);
    }

    get cardsContainer() {
      return this.document.getElementById(CARDS_ID);
    }

    #createXULElement(name) {
      if (this.document.createXULElement) {
        return this.document.createXULElement(name);
      }
      return this.document.createElementNS(
        "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
        name
      );
    }

    #installPanel() {
      if (this.panel) {
        return;
      }

      const panel = this.#createXULElement("panel");
      panel.id = PANEL_ID;
      panel.setAttribute("role", "group");
      panel.setAttribute("type", "arrow");
      panel.setAttribute("hidepopovertail", "true");
      panel.setAttribute("noautofocus", "true");
      panel.setAttribute("consumeoutsideclicks", "true");
      panel.setAttribute("animate", "false");
      panel.setAttribute("nonnativepopover", "true");

      const multiview = this.#createXULElement("panelmultiview");
      multiview.id = "zen-ctrl-tab-panel-multiview";
      multiview.setAttribute("mainViewId", "zen-ctrl-tab-panel-view");

      const view = this.#createXULElement("panelview");
      view.id = "zen-ctrl-tab-panel-view";
      view.setAttribute("class", "cui-widget-panelview");
      view.setAttribute("mainview-with-header", "true");

      const cards = this.#createXULElement("hbox");
      cards.id = CARDS_ID;
      cards.setAttribute("class", "zen-ctrl-tab-panel-cards");
      cards.setAttribute("role", "listbox");
      cards.setAttribute("aria-label", "Ctrl+Tab tabs");

      view.appendChild(cards);
      multiview.appendChild(view);
      panel.appendChild(multiview);

      const popupSet =
        this.document.getElementById("mainPopupSet") ||
        this.document.getElementById("browserPopupSet") ||
        this.document.documentElement;
      popupSet.appendChild(panel);
    }

    #patchFirefoxCtrlTab() {
      if (!this.window.ctrlTab || this.#originalCtrlTabOpen) {
        return;
      }

      this.#originalCtrlTabOpen = this.window.ctrlTab.open;
      const controller = this;
      this.window.ctrlTab.open = function ctrlTabOpenShim(...args) {
        if (getBoolPref(PREFS.enabled, true)) {
          return undefined;
        }
        return controller.#originalCtrlTabOpen.apply(this, args);
      };
    }

    #handleKeyDown(event) {
      if (!getBoolPref(PREFS.enabled, true)) {
        return;
      }

      if (this.#isOpen && event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.close(false);
        return;
      }

      if (!event.ctrlKey || event.key !== "Tab") {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      if (!this.#isOpen) {
        this.open(event.shiftKey);
      } else if (event.shiftKey) {
        this.navigateBackward();
      } else {
        this.navigateForward();
      }
    }

    #handleKeyUp(event) {
      if (this.#isOpen && event.key === "Control") {
        this.close();
      }
    }

    #handleBlur() {
      if (this.#isOpen) {
        this.close(false);
      }
    }

    #handleTabClose(event) {
      const tab = event.target;
      const tabId = tab?.linkedPanel;
      if (tabId) {
        URL.revokeObjectURL(this.#thumbnailCache.get(tabId));
        this.#thumbnailCache.delete(tabId);
      }
      if (!this.#isOpen || !this.#entryList.length) {
        return;
      }
      this.#removeTabFromEntries(tab);
    }

    #removeTabFromEntries(tab) {
      if (!tab) {
        return;
      }
      let entryIndex = this.#entryList.findIndex(entry => entry.tabs.includes(tab));
      if (entryIndex < 0) {
        return;
      }
      const entry = this.#entryList[entryIndex];
      entry.tabs = entry.tabs.filter(t => t !== tab && !t.closing);
      if (entry.tabs.length === 0) {
        this.#entryList.splice(entryIndex, 1);
        this.#tabList = this.#tabList.filter(t => t !== tab);
        if (entryIndex < this.#currentIndex) {
          this.#currentIndex = Math.max(0, this.#currentIndex - 1);
        } else if (this.#currentIndex >= this.#entryList.length) {
          this.#currentIndex = Math.max(0, this.#entryList.length - 1);
        }
        if (!this.#entryList.length) {
          this.close(false);
          return;
        }
        this.#actualVisibleCards = Math.min(
          this.#entryList.length,
          this.#getMaxCards()
        );
        this.#createTabCards();
        return;
      }
      if (entry.tabs.length === 1) {
        entry.isSplit = false;
        entry.key = `tab:${entry.tabs[0].linkedPanel}`;
        // A lone survivor is rendered as a normal tab card.
      }
      this.#tabList = this.#tabList.filter(t => t !== tab);
      this.#createTabCards();
    }

    #getMaxCards() {
      const screenWidth = this.window.screen.width;
      const getPanelWidth = cards =>
        ZenCtrlTabPanelMod.CARD_WIDTH * cards +
        ZenCtrlTabPanelMod.PANEL_PADDING * 2;

      if (screenWidth < getPanelWidth(4)) {
        return 3;
      }
      if (screenWidth < getPanelWidth(5)) {
        return 4;
      }
      return 5;
    }

    #getSplitKey(tab) {
      if (!tab) {
        return null;
      }
      try {
        const group = tab.group;
        if (
          group &&
          typeof group.hasAttribute === "function" &&
          group.hasAttribute("split-view-group")
        ) {
          return `group:${group.id || group.getAttribute?.("id") || "split"}`;
        }
      } catch (error) {}
      let isSplit = false;
      try {
        isSplit =
          tab.splitView === true ||
          (typeof tab.hasAttribute === "function" && tab.hasAttribute("split-view"));
      } catch (error) {}
      if (!isSplit) {
        return null;
      }
      try {
        const splitter = this.window.gZenViewSplitter;
        if (splitter && Array.isArray(splitter._data)) {
          const index = splitter._data.findIndex(
            group => Array.isArray(group?.tabs) && group.tabs.includes(tab)
          );
          if (index >= 0) {
            const groupId = splitter._data[index]?.groupId;
            if (groupId) {
              return `group:${groupId}`;
            }
            return `split-index:${index}`;
          }
        }
      } catch (error) {}
      try {
        if (
          tab.splitViewValue !== undefined &&
          tab.splitViewValue !== null &&
          tab.splitViewValue !== -1
        ) {
          return `split-value:${tab.splitViewValue}`;
        }
      } catch (error) {}
      return null;
    }

    #buildEntries(tabs) {
      const groupSplitView = getBoolPref(PREFS.groupSplitView, true);
      if (!groupSplitView) {
        return tabs.map(tab => {
          const splitKey = this.#getSplitKey(tab);
          return {
            key: `tab:${tab.linkedPanel}`,
            tabs: [tab],
            isSplit: splitKey !== null,
            splitKey,
          };
        });
      }
      const entries = [];
      const groupIndex = new Map();
      for (const tab of tabs) {
        const splitKey = this.#getSplitKey(tab);
        if (!splitKey) {
          entries.push({
            key: `tab:${tab.linkedPanel}`,
            tabs: [tab],
            isSplit: false,
            splitKey: null,
          });
          continue;
        }
        if (!groupIndex.has(splitKey)) {
          const entry = {
            key: splitKey,
            tabs: [],
            isSplit: true,
            splitKey,
          };
          groupIndex.set(splitKey, entry);
          entries.push(entry);
        }
        groupIndex.get(splitKey).tabs.push(tab);
      }
      // A split key with a single surviving tab is not a split view.
      for (const entry of entries) {
        if (entry.isSplit && entry.tabs.length < 2) {
          entry.isSplit = false;
          entry.key = `tab:${entry.tabs[0].linkedPanel}`;
        }
      }
      return entries;
    }

    #getEntryIndexForTab(tab) {
      if (!tab) {
        return -1;
      }
      return this.#entryList.findIndex(entry => entry.tabs.includes(tab));
    }

    #getEntryDisplayLabel(entry) {
      const labels = entry.tabs.map(tab => tab.label || "New Tab");
      if (!entry.isSplit) {
        return labels[0] || "";
      }
      if (labels.length === 2) {
        return `${labels[0]} + ${labels[1]}`;
      }
      return `${labels[0]} + ${labels.length - 1} more`;
    }

    #getActiveTabForEntry(entry) {
      if (!entry || !entry.tabs.length) {
        return null;
      }
      if (entry.tabs.length === 1) {
        return entry.tabs[0];
      }
      const usable = entry.tabs.filter(tab => !tab.closing);
      if (!usable.length) {
        return null;
      }
      if (usable.includes(gBrowser.selectedTab)) {
        // Prefer the selected tab when its split is already active so
        // re-selecting the current split does not jump tabs.
        try {
          const splitter = this.window.gZenViewSplitter;
          if (
            splitter?.splitViewActive &&
            splitter._data?.[splitter.currentView]?.tabs?.includes(
              gBrowser.selectedTab
            ) &&
            usable.includes(gBrowser.selectedTab)
          ) {
            return gBrowser.selectedTab;
          }
        } catch (error) {}
      }
      return (
        [...usable].sort(
          (a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)
        )[0] || usable[0]
      );
    }

    #activateEntry(entry) {
      if (!entry || !entry.tabs.length) {
        return;
      }
      const target = this.#getActiveTabForEntry(entry);
      if (!target || target.closing) {
        return;
      }
      if (target !== gBrowser.selectedTab) {
        gBrowser.selectedTab = target;
      }
      // Selecting a split tab triggers Zen's split activation via TabSelect,
      // but ensure the split view is active when the API is available.
      if (entry.isSplit) {
        try {
          const splitter = this.window.gZenViewSplitter;
          const groupIndex = splitter?._data?.findIndex(group =>
            group?.tabs?.some(tab => entry.tabs.includes(tab))
          );
          if (
            splitter &&
            typeof splitter.activateSplitView === "function" &&
            groupIndex >= 0 &&
            splitter.currentView !== groupIndex
          ) {
            splitter.activateSplitView(splitter._data[groupIndex], true);
          }
        } catch (error) {}
      }
    }

    async open(shiftKey = false) {
      if (this.#isOpen) {
        return;
      }

      const sortByRecentlyUsed = getBoolPref(PREFS.sortByRecentlyUsed, false);
      this.#tabList = Array.from(gBrowser.tabs).filter(tab => {
        if (tab.closing || !tab.visible || tab.hasAttribute("busy")) {
          return false;
        }
        if (sortByRecentlyUsed && tab.hasAttribute("pending")) {
          return false;
        }
        return true;
      });

      if (sortByRecentlyUsed) {
        this.#tabList.sort((tab1, tab2) => tab2.lastAccessed - tab1.lastAccessed);
      }

      this.#entryList = this.#buildEntries(this.#tabList);

      if (sortByRecentlyUsed) {
        // Keep split views together, ordered by their most recent member.
        this.#entryList.sort((a, b) => {
          const aRecent = Math.max(...a.tabs.map(tab => tab.lastAccessed || 0));
          const bRecent = Math.max(...b.tabs.map(tab => tab.lastAccessed || 0));
          return bRecent - aRecent;
        });
      }

      if (this.#entryList.length <= 1) {
        this.#entryList = [];
        this.#tabList = [];
        return;
      }

      const selectedEntryForRefresh =
        this.#getEntryIndexForTab(gBrowser.selectedTab) >= 0
          ? this.#entryList[this.#getEntryIndexForTab(gBrowser.selectedTab)]
          : null;
      const tabsToRefresh = selectedEntryForRefresh
        ? selectedEntryForRefresh.tabs
        : [gBrowser.selectedTab];
      for (const tab of tabsToRefresh) {
        const tabId = tab?.linkedPanel;
        if (!tabId) {
          continue;
        }
        URL.revokeObjectURL(this.#thumbnailCache.get(tabId));
        this.#thumbnailCache.delete(tabId);
      }

      let initialCardIndex = this.#getEntryIndexForTab(gBrowser.selectedTab);
      if (initialCardIndex < 0) {
        initialCardIndex = 0;
      }

      if (shiftKey) {
        this.#currentIndex =
          (initialCardIndex - 1 + this.#entryList.length) % this.#entryList.length;
      } else {
        this.#currentIndex = (initialCardIndex + 1) % this.#entryList.length;
      }

      this.#actualVisibleCards = Math.min(
        this.#entryList.length,
        this.#getMaxCards()
      );
      this.#isOpen = true;
      const openGeneration = ++this.#openGeneration;

      const tabboxRect = gBrowser.tabbox.getBoundingClientRect();
      const tabBoxAspectRatio = tabboxRect.width / tabboxRect.height || 1;
      const thumbnailWidth = Math.round(
        Math.min(Math.max(tabBoxAspectRatio * 500, 300), 700)
      );
      const thumbnailHeight = Math.round(thumbnailWidth / tabBoxAspectRatio);

      this.#createTabCards();
      this.#captureVisibleThumbnails(
        openGeneration,
        thumbnailWidth,
        thumbnailHeight
      );

      const scrollPosition =
        this.#getPageStartIndex(this.#currentIndex) * ZenCtrlTabPanelMod.CARD_WIDTH;
      const panelWidth =
        ZenCtrlTabPanelMod.CARD_WIDTH * this.#actualVisibleCards +
        ZenCtrlTabPanelMod.PANEL_PADDING * 2;
      const centerX = Math.max(0, (this.window.innerWidth - panelWidth) / 2);
      const centerY =
        (this.window.innerHeight - ZenCtrlTabPanelMod.PANEL_HEIGHT) / 2;

      this.panel.addEventListener(
        "popupshowing",
        () => {
          this.cardsContainer.scrollLeft = scrollPosition;
        },
        { once: true }
      );

      this.panel.addEventListener(
        "popuphidden",
        () => {
          this.close(false);
        },
        { once: true }
      );

      PanelMultiView.openPopup(this.panel, this.document.documentElement, {
        position: "overlap",
        triggerEvent: null,
        x: centerX,
        y: centerY,
      });
    }

    close(switchTab = true) {
      if (!this.#isOpen) {
        return;
      }

      const selectedEntry = this.#entryList[this.#currentIndex];
      if (switchTab && selectedEntry) {
        this.#activateEntry(selectedEntry);
      }

      this.#isOpen = false;
      this.#openGeneration++;
      this.#currentIndex = 0;
      this.#tabList = [];
      this.#entryList = [];
      this.#actualVisibleCards = undefined;
      this.panel?.hidePopup();
    }

    #getVisibleTabs() {
      const visibleStart = this.#getPageStartIndex(this.#currentIndex);
      const visibleEnd = visibleStart + this.#actualVisibleCards;
      const visibleEntries = this.#entryList.slice(visibleStart, visibleEnd);
      const visibleTabs = visibleEntries.flatMap(entry => entry.tabs);
      const remainingTabs = this.#tabList.filter(tab => !visibleTabs.includes(tab));
      return { visibleTabs, remainingTabs };
    }

    async #captureVisibleThumbnails(openGeneration, thumbnailWidth, thumbnailHeight) {
      const { visibleTabs, remainingTabs } = this.#getVisibleTabs();

      for (const tab of [...visibleTabs, ...remainingTabs]) {
        try {
          await this.#captureThumbnail(tab, thumbnailWidth, thumbnailHeight);
        } catch (error) {}

        if (!this.#isOpen || openGeneration !== this.#openGeneration) {
          return;
        }

        this.#updateCardThumbnail(tab);
      }
    }

    async #captureThumbnail(tab, thumbnailWidth, thumbnailHeight) {
      const browser = tab.linkedBrowser;
      const tabId = tab.linkedPanel;

      if (
        tab.hasAttribute("pending") ||
        tab.closing ||
        this.#thumbnailCache.has(tabId) ||
        !browser ||
        !this.window.PageThumbs
      ) {
        return;
      }

      const canvas = this.document.createElement("canvas");
      canvas.width = thumbnailWidth;
      canvas.height = thumbnailHeight;

      await this.window.PageThumbs.captureToCanvas(browser, canvas, {
        fullViewport: true,
      });

      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (blob) {
        this.#thumbnailCache.set(tabId, URL.createObjectURL(blob));
      }
    }

    #resolveFavicon(tab, defaultFavicon, newTabFavicon) {
      let iconSrc = "";
      try {
        iconSrc = gBrowser.getIcon(tab) || defaultFavicon;
      } catch (error) {
        iconSrc = defaultFavicon;
      }
      if (iconSrc && iconSrc.startsWith("chrome://branding/content/")) {
        iconSrc = newTabFavicon;
      }
      return iconSrc;
    }

    #createSingleThumbnailContent(tab) {
      const thumbnail = tab.hasAttribute("pending")
        ? null
        : this.#thumbnailCache.get(tab.linkedPanel);
      if (!thumbnail) {
        return null;
      }
      const img = this.document.createElement("img");
      img.src = thumbnail;
      img.setAttribute("alt", "");
      return img;
    }

    #createTabCards() {
      if (!this.cardsContainer) {
        return;
      }

      const defaultFavicon = PlacesUtils.favicons.defaultFavicon.spec;
      const newTabFavicon = "chrome://browser/skin/zen-icons/new-tab-image.svg";

      this.cardsContainer.replaceChildren();
      this.cardsContainer.style.width = `${
        ZenCtrlTabPanelMod.CARD_WIDTH * this.#actualVisibleCards
      }px`;

      this.#entryList.forEach((entry, index) => {
        const isSplit = entry.isSplit && entry.tabs.length > 1;
        const card = this.document.createElement("div");
        card.className =
          "zen-ctrl-tab-panel-card" + (isSplit ? " zen-ctrl-tab-panel-card-split" : "");
        card.setAttribute("role", "option");
        card.setAttribute("aria-selected", index === this.#currentIndex ? "true" : "false");
        card.dataset.entryId = entry.key;
        if (isSplit) {
          card.setAttribute(
            "title",
            entry.tabs.map(tab => tab.label || "New Tab").join(" + ")
          );
          card.setAttribute("aria-label", `Split view: ${this.#getEntryDisplayLabel(entry)}`);
        } else {
          const soleTab = entry.tabs[0];
          card.setAttribute("title", soleTab?.label || "");
          card.dataset.tabId = soleTab?.linkedPanel || "";
          if (entry.isSplit || this.#getSplitKey(soleTab)) {
            card.classList.add("zen-ctrl-tab-panel-was-split");
          }
        }

        const thumbnailContainer = this.document.createElement("div");
        thumbnailContainer.className = "zen-ctrl-tab-panel-thumbnail";
        if (isSplit) {
          thumbnailContainer.classList.add("zen-ctrl-tab-panel-split-thumbnails");
          thumbnailContainer.dataset.splitCount = String(entry.tabs.length);
        }

        if (isSplit) {
          let hasAnyThumbnail = false;
          for (const tab of entry.tabs) {
            const slot = this.document.createElement("div");
            slot.className = "zen-ctrl-tab-panel-split-thumb";
            slot.dataset.tabId = tab.linkedPanel;
            const content = this.#createSingleThumbnailContent(tab);
            if (content) {
              slot.appendChild(content);
              hasAnyThumbnail = true;
            } else {
              slot.classList.add("zen-ctrl-tab-panel-split-thumb-empty");
            }
            thumbnailContainer.appendChild(slot);
          }
          if (!hasAnyThumbnail) {
            card.classList.add("zen-ctrl-tab-panel-no-thumbnail");
          }
        } else {
          const soleTab = entry.tabs[0];
          const content = soleTab ? this.#createSingleThumbnailContent(soleTab) : null;
          if (content) {
            thumbnailContainer.appendChild(content);
          } else {
            card.classList.add("zen-ctrl-tab-panel-no-thumbnail");
          }
        }

        card.appendChild(thumbnailContainer);

        const infoContainer = this.document.createElement("div");
        infoContainer.className = "zen-ctrl-tab-panel-info";

        if (isSplit) {
          const stack = this.document.createElement("div");
          stack.className = "zen-ctrl-tab-panel-favicon-stack";
          for (const tab of entry.tabs.slice(0, 4)) {
            const favicon = this.document.createElement("img");
            favicon.className = "zen-ctrl-tab-panel-favicon";
            favicon.src = this.#resolveFavicon(tab, defaultFavicon, newTabFavicon);
            favicon.setAttribute("alt", "");
            stack.appendChild(favicon);
          }
          infoContainer.appendChild(stack);

          const title = this.document.createElement("div");
          title.className = "zen-ctrl-tab-panel-title";
          title.textContent = this.#getEntryDisplayLabel(entry);
          infoContainer.appendChild(title);

          const badge = this.document.createElement("div");
          badge.className = "zen-ctrl-tab-panel-split-badge";
          badge.textContent = `Split · ${entry.tabs.length}`;
          infoContainer.appendChild(badge);
        } else {
          const soleTab = entry.tabs[0];
          const favicon = this.document.createElement("img");
          favicon.className = "zen-ctrl-tab-panel-favicon";
          favicon.src = this.#resolveFavicon(soleTab, defaultFavicon, newTabFavicon);
          infoContainer.appendChild(favicon);

          const title = this.document.createElement("div");
          title.className = "zen-ctrl-tab-panel-title";
          title.textContent = soleTab?.label || "";
          infoContainer.appendChild(title);

          if (soleTab?.hasAttribute("pending")) {
            card.classList.add("zen-ctrl-tab-panel-pending");
          }
          if (entry.isSplit || (soleTab && this.#getSplitKey(soleTab))) {
            const badge = this.document.createElement("div");
            badge.className = "zen-ctrl-tab-panel-split-badge";
            badge.textContent = "Split";
            infoContainer.appendChild(badge);
            card.classList.add("zen-ctrl-tab-panel-card-lone-split");
          }
        }

        card.appendChild(infoContainer);

        if (index === this.#currentIndex) {
          card.classList.add("zen-ctrl-tab-panel-selected");
        }

        card.addEventListener("click", () => {
          this.#currentIndex = index;
          this.close();
        });

        card.addEventListener("mouseenter", () => {
          if (this.#currentIndex === index) {
            return;
          }
          const previousIndex = this.#currentIndex;
          this.#currentIndex = index;
          this.#updateSelection(previousIndex, { scroll: false });
        });

        this.cardsContainer.appendChild(card);
      });
    }

    #updateCardThumbnail(tab) {
      if (!tab) {
        return;
      }
      const thumbnail = this.#thumbnailCache.get(tab.linkedPanel);
      if (!thumbnail) {
        return;
      }
      const escapedId = CSS.escape(tab.linkedPanel);
      // Split-view slot first: update only the matching sub-thumbnail.
      const slot = this.cardsContainer?.querySelector(
        `.zen-ctrl-tab-panel-split-thumb[data-tab-id="${escapedId}"]`
      );
      if (slot) {
        slot.replaceChildren();
        const img = this.document.createElement("img");
        img.src = thumbnail;
        img.setAttribute("alt", "");
        slot.appendChild(img);
        slot.classList.remove("zen-ctrl-tab-panel-split-thumb-empty");
        slot.closest(CARD_SELECTOR)?.classList.remove("zen-ctrl-tab-panel-no-thumbnail");
        return;
      }
      const card = this.cardsContainer?.querySelector(
        `${CARD_SELECTOR}[data-tab-id="${escapedId}"]`
      );
      const thumbnailContainer = card?.querySelector(".zen-ctrl-tab-panel-thumbnail");
      if (!card || !thumbnailContainer) {
        return;
      }

      thumbnailContainer.replaceChildren();
      const img = this.document.createElement("img");
      img.src = thumbnail;
      img.setAttribute("alt", "");
      thumbnailContainer.appendChild(img);
      card.classList.remove("zen-ctrl-tab-panel-no-thumbnail");
    }

    #updateSelection(previousIndex, options = {}) {
      if (!this.cardsContainer?.children.length) {
        return;
      }

      const previousCard = this.cardsContainer.children[previousIndex];
      const currentCard = this.cardsContainer.children[this.#currentIndex];
      previousCard?.classList.remove("zen-ctrl-tab-panel-selected");
      previousCard?.setAttribute("aria-selected", "false");
      currentCard?.classList.add("zen-ctrl-tab-panel-selected");
      currentCard?.setAttribute("aria-selected", "true");

      if (options.scroll === false) {
        return;
      }

      const scrollPosition =
        this.#getPageStartIndex(this.#currentIndex) * ZenCtrlTabPanelMod.CARD_WIDTH;

      this.cardsContainer.scrollTo({
        left: scrollPosition,
        behavior: "smooth",
      });
    }

    #getPageStartIndex(currentCardIndex) {
      const totalCards = this.#entryList.length;
      const maxVisible = this.#actualVisibleCards;

      if (totalCards <= maxVisible) {
        return 0;
      }

      const pageStartIndex = Math.floor(currentCardIndex / maxVisible) * maxVisible;
      if (pageStartIndex + maxVisible > totalCards) {
        return totalCards - maxVisible;
      }

      return pageStartIndex;
    }

    navigateForward() {
      if (!this.#entryList.length) {
        return;
      }
      const previousIndex = this.#currentIndex;
      this.#currentIndex = (this.#currentIndex + 1) % this.#entryList.length;
      this.#updateSelection(previousIndex);
    }

    navigateBackward() {
      if (!this.#entryList.length) {
        return;
      }
      const previousIndex = this.#currentIndex;
      this.#currentIndex =
        (this.#currentIndex - 1 + this.#entryList.length) % this.#entryList.length;
      this.#updateSelection(previousIndex);
    }

    destroy() {
      this.#entryList = [];
      this.window.removeEventListener("keydown", this.onKeyDown, true);
      this.window.removeEventListener("keyup", this.onKeyUp, true);
      this.window.removeEventListener("blur", this.onBlur);
      this.window.removeEventListener("TabClose", this.onTabClose);

      if (this.window.ctrlTab && this.#originalCtrlTabOpen) {
        this.window.ctrlTab.open = this.#originalCtrlTabOpen;
      }

      for (const thumbnail of this.#thumbnailCache.values()) {
        URL.revokeObjectURL(thumbnail);
      }
      this.#thumbnailCache.clear();
      this.panel?.remove();
      delete this.window.gZenCtrlTabPanel;
      delete this.window[CONTROLLER_KEY];
    }
  }

  const controller = new ZenCtrlTabPanelMod(window);
  window[CONTROLLER_KEY] = controller;
  window.gZenCtrlTabPanel = controller;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => controller.init(), { once: true });
  } else {
    controller.init();
  }
})();
