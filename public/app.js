(function () {
  "use strict";

  var POLL_MS = 1500;
  var TICK_MS = 1000;
  var COUNT_MS = 400;
  var LEAVE_MS = 240;
  var TIMELINE_SLOTS = 20;
  var MIN_LABEL_WIDTH = 34;
  var TIERS = ["critical", "high", "normal", "low"];
  var TIER_LEVEL = { critical: 1, high: 0.72, normal: 0.44, low: 0.16 };
  var CHANNEL_LABEL = { call: "Phone call", sms: "SMS", voice: "Voice note", log: "Logged only" };
  var SOURCE_LABEL = { gmail: "Gmail", calendar: "Calendar", telegram: "Telegram", discord: "Discord" };
  var RESPONSE_LABEL = { approved: "Approved", rejected: "Declined", ignored: "Ignored" };
  var WORKING_LABEL = { approve: "Releasing…", decline: "Declining…" };
  var WITHHELD_TEXT = "Financial or one-time-code material is never stored or read aloud.";
  var DASH = "–";
  var SVG_NS = "http://www.w3.org/2000/svg";

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var dot = document.getElementById("status-dot");
  var linkState = document.getElementById("link-state");
  var pulse = document.getElementById("pulse");
  var feed = document.getElementById("feed");
  var pendingList = document.getElementById("pending");
  var tierBar = document.getElementById("tier-bar");
  var spark = document.getElementById("spark");
  var sparkPlot = document.getElementById("spark-plot");
  var lastEvent = document.getElementById("last-event");
  var templates = {
    lock: document.getElementById("lock-icon"),
    clear: document.getElementById("clear-icon"),
    tray: document.getElementById("tray-icon"),
    chevron: document.getElementById("chevron-icon")
  };
  var today = {
    toggle: document.getElementById("today-toggle"),
    body: document.getElementById("today-body"),
    headline: document.getElementById("today-headline"),
    content: document.getElementById("today-content"),
    status: document.getElementById("today-status")
  };
  var manage = {
    toggle: document.getElementById("manage-toggle"),
    panel: document.getElementById("manage-panel"),
    note: document.getElementById("manage-note")
  };

  var firstRender = true;
  var lastData = null;
  var lastEventAt = null;
  var lastTimeline = [];
  var sourceFilter = "";
  var seenDecisions = {};
  var seenPending = {};
  var handledPending = {};
  var cardState = {};
  var lastFeedSig = null;
  var lastPendingSig = null;
  var lastTimelineSig = null;

  pulse.style.setProperty("--poll", POLL_MS + "ms");

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  }

  function icon(name) {
    return templates[name].content.cloneNode(true);
  }

  function label(map, key) {
    return map[key] || String(key || "");
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function relativeTime(iso) {
    var diff = Date.now() - Date.parse(iso);
    if (!isFinite(diff)) return "";
    var s = Math.round(diff / 1000);
    if (s < 45) return "just now";
    var m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.round(m / 60);
    if (h < 24) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }

  // Seconds resolution for the header ticker so the page visibly moves while idle.
  function preciseTime(iso) {
    var s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
    if (!isFinite(s)) return "";
    if (s < 0) s = 0;
    if (s < 60) return s + "s ago";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m " + pad(s % 60) + "s ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h " + pad(m % 60) + "m ago";
    return Math.floor(h / 24) + "d ago";
  }

  function timeRemaining(iso) {
    var ms = Date.parse(iso) - Date.now();
    if (!isFinite(ms)) return "";
    if (ms <= 0) return "Expired";
    var total = Math.ceil(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return (h ? h + ":" + pad(m) : String(m)) + ":" + pad(s) + " left";
  }

  function remainingFraction(createdAt, expiresAt) {
    var span = Date.parse(expiresAt) - Date.parse(createdAt);
    var left = Date.parse(expiresAt) - Date.now();
    if (!isFinite(span) || span <= 0 || !isFinite(left)) return 0;
    return Math.max(0, Math.min(1, left / span));
  }

  function duration(seconds) {
    if (seconds < 60) return seconds + "s";
    if (seconds < 3600) return Math.round(seconds / 60) + "m";
    return Math.round(seconds / 3600) + "h";
  }

  function timeNode(iso, className) {
    var node = el("time", className, relativeTime(iso));
    node.setAttribute("datetime", iso || "");
    node.setAttribute("data-ts", iso || "");
    return node;
  }

  function pendingKey(item) {
    return (item.code || "") + "@" + (item.createdAt || "");
  }

  // Live clocks: stamps, countdowns, TTL tracks and the header ticker refresh without a refetch.
  function tick() {
    var stamps = document.querySelectorAll("[data-ts]");
    for (var i = 0; i < stamps.length; i++) {
      stamps[i].textContent = relativeTime(stamps[i].getAttribute("data-ts"));
    }
    var timers = document.querySelectorAll("[data-expires]");
    for (var j = 0; j < timers.length; j++) {
      timers[j].textContent = timeRemaining(timers[j].getAttribute("data-expires"));
    }
    var tracks = document.querySelectorAll("[data-ttl-from]");
    for (var k = 0; k < tracks.length; k++) {
      var fraction = remainingFraction(tracks[k].getAttribute("data-ttl-from"), tracks[k].getAttribute("data-ttl-to"));
      tracks[k].style.transform = "scaleX(" + fraction.toFixed(4) + ")";
    }
    if (lastEventAt) lastEvent.textContent = preciseTime(lastEventAt);
  }

  function setStatus(state) {
    dot.setAttribute("data-state", state);
    linkState.hidden = state !== "stale";
  }

  function restartPulse() {
    pulse.classList.remove("run");
    void pulse.offsetWidth;
    pulse.classList.add("run");
  }

  // Counts from the value on screen to the new one; a newer call cancels an older run.
  function setNumber(node, value) {
    var from = parseInt(node.textContent, 10);
    node._count = null;
    if (firstRender || !isFinite(from) || from === value || reducedMotion.matches) {
      node.textContent = String(value);
      return;
    }
    var token = {};
    var start = performance.now();
    node._count = token;
    function step(now) {
      if (node._count !== token) return;
      var t = Math.min(1, (now - start) / COUNT_MS);
      var eased = 1 - Math.pow(1 - t, 3);
      node.textContent = String(Math.round(from + (value - from) * eased));
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function emptyState(name, title, copy) {
    var node = el("div", "empty");
    node.appendChild(icon(name));
    node.appendChild(el("span", "empty-title", title));
    if (copy) node.appendChild(el("span", "empty-copy", copy));
    return node;
  }

  function pendingEmpty() {
    return emptyState("clear", "Nothing awaiting your approval.", "Drafted actions appear here until you release or decline them.");
  }

  function feedEmpty() {
    if (sourceFilter) return emptyState("tray", "Nothing from " + label(SOURCE_LABEL, sourceFilter) + " yet.", "Decisions from this source appear here as they are made.");
    return emptyState("tray", "No decisions recorded yet.", "Each event Valey sees is judged and logged here.");
  }

  function renderStats(stats, adapters) {
    var values = document.querySelectorAll("[data-stat]");
    for (var i = 0; i < values.length; i++) {
      var key = values[i].getAttribute("data-stat");
      if (typeof stats[key] === "number") setNumber(values[i], stats[key]);
      else values[i].textContent = DASH;
    }

    var active = 0;
    for (var j = 0; j < adapters.length; j++) if (adapters[j].active) active++;
    document.querySelector("[data-adapters]").textContent = String(active);
    document.querySelector("[data-adapters-label]").textContent = active === 1 ? "adapter active" : "adapters active";

    var avg = document.getElementById("avg-response");
    avg.textContent = typeof stats.avgResponseSeconds === "number" ? "Avg response " + duration(stats.avgResponseSeconds) : "";

    if (typeof stats.last24h === "number") {
      today.headline.textContent = stats.last24h ? stats.last24h + (stats.last24h === 1 ? " event" : " events") + " in the last 24 hours" : "No events in the last 24 hours";
    }
  }

  function renderTiers(stats) {
    var total = 0;
    var parts = [];
    for (var i = 0; i < TIERS.length; i++) {
      var n = Number(stats[TIERS[i]]) || 0;
      total += n;
      parts.push(TIERS[i] + " " + n);
      setNumber(document.querySelector("[data-legend=" + TIERS[i] + "]"), n);
    }
    var inner = tierBar.clientWidth - 6;
    for (var k = 0; k < TIERS.length; k++) {
      var seg = tierBar.querySelector("[data-tier=" + TIERS[k] + "]");
      var count = Number(stats[TIERS[k]]) || 0;
      var pct = total ? 100 * count / total : 0;
      seg.hidden = count === 0;
      seg.style.width = pct.toFixed(2) + "%";
      var labelled = inner * pct / 100 >= MIN_LABEL_WIDTH;
      seg.setAttribute("data-labelled", labelled ? "true" : "false");
      seg.firstElementChild.textContent = labelled ? Math.round(pct) + "%" : "";
    }
    tierBar.setAttribute("aria-label", total ? "Urgency tiers: " + parts.join(", ") : "No events yet");
  }

  function dominantTier(timeline) {
    var counts = {};
    for (var i = 0; i < timeline.length; i++) counts[timeline[i].tier] = (counts[timeline[i].tier] || 0) + 1;
    var best = "low";
    var bestCount = 0;
    for (var t = TIERS.length - 1; t >= 0; t--) {
      if ((counts[TIERS[t]] || 0) >= bestCount) {
        best = TIERS[t];
        bestCount = counts[TIERS[t]] || 0;
      }
    }
    return best;
  }

  // Catmull-Rom through the points, emitted as cubic segments so the curve passes through every event.
  function smoothPath(points) {
    if (points.length < 2) return "";
    var d = "M" + points[0].x.toFixed(1) + " " + points[0].y.toFixed(1);
    for (var i = 0; i < points.length - 1; i++) {
      var p0 = points[i - 1] || points[i];
      var p1 = points[i];
      var p2 = points[i + 1];
      var p3 = points[i + 2] || p2;
      var c1x = p1.x + (p2.x - p0.x) / 6;
      var c1y = p1.y + (p2.y - p0.y) / 6;
      var c2x = p2.x - (p3.x - p1.x) / 6;
      var c2y = p2.y - (p3.y - p1.y) / 6;
      d += " C" + c1x.toFixed(1) + " " + c1y.toFixed(1) + " " + c2x.toFixed(1) + " " + c2y.toFixed(1) + " " + p2.x.toFixed(1) + " " + p2.y.toFixed(1);
    }
    return d;
  }

  // Twenty slots, oldest left, drawn in real pixels so strokes and the marker stay round.
  function renderSpark(timeline) {
    lastTimeline = timeline;
    var width = spark.clientWidth || 300;
    var height = spark.clientHeight || 56;
    var sig = width + "x" + height + ":" + JSON.stringify(timeline);
    if (sig === lastTimelineSig) return;
    lastTimelineSig = sig;

    var padX = 6;
    var padTop = 6;
    var padBottom = 4;
    var floor = height - padBottom;
    var step = (width - padX * 2) / (TIMELINE_SLOTS - 1);
    var offset = TIMELINE_SLOTS - timeline.length;
    var frag = document.createDocumentFragment();

    frag.appendChild(svgEl("line", { "class": "baseline", x1: padX, y1: floor, x2: width - padX, y2: floor }));

    var points = [];
    for (var i = 0; i < timeline.length; i++) {
      var level = TIER_LEVEL[timeline[i].tier] || TIER_LEVEL.low;
      points.push({ x: padX + (offset + i) * step, y: padTop + (1 - level) * (floor - padTop) });
    }

    if (points.length >= 2) {
      var line = smoothPath(points);
      var last = points[points.length - 1];
      var first = points[0];
      frag.appendChild(svgEl("path", { "class": "area", d: line + " L" + last.x.toFixed(1) + " " + floor + " L" + first.x.toFixed(1) + " " + floor + " Z" }));
      frag.appendChild(svgEl("path", { "class": "line", d: line }));
    }

    if (points.length) {
      var tip = points[points.length - 1];
      frag.appendChild(svgEl("circle", { "class": "ring", cx: tip.x.toFixed(1), cy: tip.y.toFixed(1), r: 3 }));
      frag.appendChild(svgEl("circle", { "class": "point", cx: tip.x.toFixed(1), cy: tip.y.toFixed(1), r: 2.5 }));
    }

    spark.setAttribute("viewBox", "0 0 " + width + " " + height);
    spark.setAttribute("class", "spark " + (timeline.length ? dominantTier(timeline) : "low"));
    sparkPlot.replaceChildren(frag);
    spark.setAttribute("aria-label", timeline.length ? "Urgency of the last " + timeline.length + " events" : "No events yet");
  }

  function pendingCard(item) {
    var key = pendingKey(item);
    var card = el("article", "card approval");
    card.setAttribute("data-key", key);
    card.setAttribute("data-code", item.code || "");

    var head = el("div", "card-head");
    head.appendChild(el("span", "code", item.code || DASH));
    var remaining = el("span", "time remaining", timeRemaining(item.expiresAt));
    remaining.setAttribute("data-expires", item.expiresAt || "");
    head.appendChild(remaining);
    card.appendChild(head);

    var ttl = el("div", "ttl");
    var fill = el("div", "ttl-fill");
    fill.setAttribute("data-ttl-from", item.createdAt || "");
    fill.setAttribute("data-ttl-to", item.expiresAt || "");
    fill.style.transform = "scaleX(" + remainingFraction(item.createdAt, item.expiresAt).toFixed(4) + ")";
    ttl.appendChild(fill);
    card.appendChild(ttl);

    card.appendChild(el("p", "summary", (item.action && item.action.summary) || "Proposed action"));

    var foot = el("div", "card-foot");
    foot.appendChild(el("span", "meta-key", "Asked via"));
    foot.appendChild(el("span", null, label(CHANNEL_LABEL, item.channel)));
    card.appendChild(foot);

    var actions = el("div", "actions");
    var release = el("button", "btn primary", "Release");
    release.type = "button";
    release.setAttribute("data-act", "approve");
    var decline = el("button", "btn", "Decline");
    decline.type = "button";
    decline.setAttribute("data-act", "decline");
    actions.appendChild(release);
    actions.appendChild(decline);
    card.appendChild(actions);

    var note = el("p", "note");
    note.hidden = true;
    card.appendChild(note);

    applyCardState(card, cardState[key]);
    return card;
  }

  // Working and failure states live in cardState so a poll re-render cannot wipe them mid-request.
  function applyCardState(card, state) {
    var buttons = card.querySelectorAll("[data-act]");
    var note = card.querySelector(".note");
    var busy = state && state.working;
    for (var i = 0; i < buttons.length; i++) {
      var act = buttons[i].getAttribute("data-act");
      buttons[i].disabled = Boolean(busy);
      buttons[i].textContent = busy === act ? WORKING_LABEL[act] : (act === "approve" ? "Release" : "Decline");
    }
    if (busy) card.setAttribute("aria-busy", "true");
    else card.removeAttribute("aria-busy");
    note.hidden = !(state && state.error);
    note.textContent = (state && state.error) || "";
  }

  function withheldCard(entry) {
    var card = el("article", "card withheld");
    var head = el("div", "card-head");
    head.appendChild(el("span", "source", label(SOURCE_LABEL, entry.source)));
    head.appendChild(el("span", "chip withheld", "Withheld"));
    head.appendChild(timeNode(entry.recordedAt, "time"));
    card.appendChild(head);

    var body = el("div", "withheld-body");
    var lock = el("span", "lock");
    lock.appendChild(icon("lock"));
    body.appendChild(lock);
    var text = el("p", "withheld-text");
    text.appendChild(el("strong", null, "Content withheld."));
    text.appendChild(el("span", null, WITHHELD_TEXT));
    body.appendChild(text);
    card.appendChild(body);

    var foot = el("div", "card-foot");
    foot.appendChild(el("span", "meta-key", "Channel"));
    foot.appendChild(el("span", null, CHANNEL_LABEL.log));
    card.appendChild(foot);
    return card;
  }

  function ledgerLine(entry) {
    var line = el("div", "ledger");
    line.setAttribute("role", "note");
    var text = el("span", "ledger-text");
    text.appendChild(el("span", null, entry.reason || "Activity log cleared."));
    var removed = Number(entry.removed) || 0;
    text.appendChild(el("span", "num", removed + (removed === 1 ? " entry archived." : " entries archived.")));
    text.appendChild(timeNode(entry.recordedAt, "time"));
    line.appendChild(text);
    return line;
  }

  function decisionCard(entry) {
    if (entry.kind === "marker") return ledgerLine(entry);
    if (entry.category === "financial") return withheldCard(entry);

    var tier = TIERS.indexOf(entry.tier) >= 0 ? entry.tier : "low";
    var card = el("article", "card tier-" + tier);
    var head = el("div", "card-head");
    head.appendChild(el("span", "source", label(SOURCE_LABEL, entry.source)));
    head.appendChild(el("span", "chip " + tier, entry.tier || "unknown"));
    head.appendChild(timeNode(entry.recordedAt, "time"));
    card.appendChild(head);

    card.appendChild(el("p", "card-body", entry.reason || ""));
    if (entry.redactedText) {
      card.appendChild(el("p", "preview", String(entry.redactedText).replace(/\s+/g, " ").trim()));
    }

    var foot = el("div", "card-foot");
    foot.appendChild(el("span", "meta-key", "Channel"));
    foot.appendChild(el("span", null, label(CHANNEL_LABEL, entry.channel)));
    if (entry.response && RESPONSE_LABEL[entry.response]) {
      foot.appendChild(el("span", "response", RESPONSE_LABEL[entry.response]));
    }
    card.appendChild(foot);
    return card;
  }

  function renderList(container, items, keyOf, build, fresh, animClass, empty) {
    var frag = document.createDocumentFragment();
    if (!items.length) frag.appendChild(empty());
    for (var i = 0; i < items.length; i++) {
      var node = build(items[i]);
      if (!firstRender && fresh[keyOf(items[i])]) node.classList.add(node.classList.contains("ledger") ? "enter" : animClass);
      frag.appendChild(node);
    }
    container.replaceChildren(frag);
  }

  function renderPending(pending, fresh) {
    var visible = [];
    for (var i = 0; i < pending.length; i++) {
      if (!handledPending[pendingKey(pending[i])]) visible.push(pending[i]);
    }
    var sig = JSON.stringify(visible);
    if (sig === lastPendingSig) return;
    lastPendingSig = sig;
    renderList(pendingList, visible, pendingKey, pendingCard, fresh, "enter", pendingEmpty);
    document.getElementById("pending-count").textContent = visible.length ? String(visible.length) : "";
  }

  // Ledger markers ignore the source filter and never count as events.
  function renderFeed(decisions, fresh) {
    var visible = [];
    var events = 0;
    for (var i = 0; i < decisions.length; i++) {
      var isMarker = decisions[i].kind === "marker";
      if (isMarker || !sourceFilter || decisions[i].source === sourceFilter) visible.push(decisions[i]);
      if (!isMarker && (!sourceFilter || decisions[i].source === sourceFilter)) events++;
    }
    var sig = sourceFilter + "|" + JSON.stringify(visible);
    if (sig === lastFeedSig) return;
    lastFeedSig = sig;
    var onlyMarkers = visible.length && events === 0;
    renderList(feed, onlyMarkers ? [] : visible, function (d) { return d.id; }, decisionCard, fresh, "flash", feedEmpty);
    if (onlyMarkers) {
      for (var m = 0; m < visible.length; m++) feed.appendChild(ledgerLine(visible[m]));
    }
    document.getElementById("feed-count").textContent = events ? String(events) : "";
  }

  function render(data) {
    lastData = data;
    var stats = data.stats || {};
    var decisions = Array.isArray(data.decisions) ? data.decisions : [];
    var pending = Array.isArray(data.pending) ? data.pending : [];
    var timeline = Array.isArray(data.timeline) ? data.timeline : [];

    // Mark arrivals against everything fetched, not just what the filter shows.
    var freshDecisions = {};
    for (var i = 0; i < decisions.length; i++) {
      if (!seenDecisions[decisions[i].id]) freshDecisions[decisions[i].id] = seenDecisions[decisions[i].id] = true;
    }
    var freshPending = {};
    for (var j = 0; j < pending.length; j++) {
      var key = pendingKey(pending[j]);
      if (!seenPending[key]) freshPending[key] = seenPending[key] = true;
    }

    if (decisions.length && decisions[0].recordedAt) {
      lastEventAt = decisions[0].recordedAt;
      lastEvent.textContent = preciseTime(lastEventAt);
    }

    renderStats(stats, Array.isArray(data.adapters) ? data.adapters : []);
    renderTiers(stats);
    renderSpark(timeline);
    renderPending(pending, freshPending);
    renderFeed(decisions, freshDecisions);
    firstRender = false;
  }

  function detachCard(card) {
    if (card.parentNode) card.parentNode.removeChild(card);
    if (!pendingList.querySelector(".card")) {
      pendingList.replaceChildren(pendingEmpty());
    }
    var left = pendingList.querySelectorAll(".card").length;
    document.getElementById("pending-count").textContent = left ? String(left) : "";
  }

  function removeCard(card) {
    if (reducedMotion.matches) {
      detachCard(card);
      return;
    }
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      detachCard(card);
    }
    card.addEventListener("animationend", finish);
    setTimeout(finish, LEAVE_MS + 100);
    card.classList.add("leave");
  }

  function act(card, action) {
    var key = card.getAttribute("data-key");
    var code = card.getAttribute("data-code");
    cardState[key] = { working: action };
    applyCardState(card, cardState[key]);

    fetch("/api/" + action, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code })
    })
      .then(function (response) { return response.json(); })
      .catch(function () { return { ok: false, reason: "Could not reach Valey. Try again." }; })
      .then(function (result) {
        var current = pendingList.querySelector('[data-key="' + key + '"]') || card;
        if (result && result.ok) {
          handledPending[key] = true;
          delete cardState[key];
          removeCard(current);
          return;
        }
        cardState[key] = { error: (result && result.reason) || "Request failed." };
        applyCardState(current, cardState[key]);
      });
  }

  pendingList.addEventListener("click", function (event) {
    var button = event.target.closest("[data-act]");
    if (!button || button.disabled) return;
    var card = button.closest(".approval");
    if (card) act(card, button.getAttribute("data-act"));
  });

  document.getElementById("filters").addEventListener("click", function (event) {
    var button = event.target.closest("[data-source]");
    if (!button) return;
    sourceFilter = button.getAttribute("data-source") || "";
    var buttons = button.parentNode.querySelectorAll("[data-source]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", buttons[i] === button ? "true" : "false");
    }
    if (lastData) renderFeed(Array.isArray(lastData.decisions) ? lastData.decisions : [], {});
  });

  // Today: fetched on expand and on refresh, never in the poll loop.
  function todayButtons(disabled, workingKey) {
    var buttons = today.body.querySelectorAll("[data-today]");
    for (var i = 0; i < buttons.length; i++) {
      var key = buttons[i].getAttribute("data-today");
      buttons[i].disabled = disabled;
      buttons[i].textContent = key === "speak" ? (workingKey === "speak" ? "Sending…" : "Send as voice note") : (workingKey === "refresh" ? "Refreshing…" : "Refresh");
    }
  }

  function todayStatus(text, tone) {
    today.status.hidden = !text;
    today.status.textContent = text || "";
    if (tone) today.status.setAttribute("data-tone", tone);
    else today.status.removeAttribute("data-tone");
  }

  function todaySkeleton() {
    var box = el("div", "skeleton");
    box.setAttribute("aria-hidden", "true");
    for (var i = 0; i < 4; i++) box.appendChild(el("span"));
    return box;
  }

  function todayFailure() {
    var box = el("div");
    box.appendChild(el("p", "today-status", "The summary could not be built."));
    var retry = el("button", "retry", "Try again");
    retry.type = "button";
    retry.setAttribute("data-today", "retry");
    box.appendChild(retry);
    return box;
  }

  function loadSummary() {
    today.content.replaceChildren(todaySkeleton());
    today.content.setAttribute("aria-busy", "true");
    todayStatus("");
    todayButtons(true, "refresh");

    fetch("/api/summary", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then(function (data) {
        var text = el("p", "today-text", (data && data.text) || "Valey has nothing to report yet.");
        var stamp = Date.parse(data && data.generatedAt);
        var meta = el("p", "today-meta", isFinite(stamp) ? "Generated " + new Date(stamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
        today.content.replaceChildren(text, meta);
        if (data && data.counts && typeof data.counts.handled === "number") {
          today.headline.textContent = data.counts.handled ? data.counts.handled + (data.counts.handled === 1 ? " event" : " events") + " in the last 24 hours" : "No events in the last 24 hours";
        }
      })
      .catch(function () {
        today.content.replaceChildren(todayFailure());
      })
      .then(function () {
        today.content.removeAttribute("aria-busy");
        todayButtons(false);
      });
  }

  function speakSummary() {
    todayStatus("");
    todayButtons(true, "speak");
    fetch("/api/summary/speak", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .then(function (response) { return response.json(); })
      .catch(function () { return { ok: false, reason: "Could not reach Valey. Try again." }; })
      .then(function (result) {
        if (result && result.ok) todayStatus(result.degraded ? "Sent as text" : "Sent as voice note");
        else todayStatus((result && result.reason) || "The voice note could not be sent.", "error");
        todayButtons(false);
      });
  }

  today.toggle.addEventListener("click", function () {
    var open = today.toggle.getAttribute("aria-expanded") !== "true";
    today.toggle.setAttribute("aria-expanded", open ? "true" : "false");
    today.body.hidden = !open;
    if (open) loadSummary();
  });

  today.body.addEventListener("click", function (event) {
    var button = event.target.closest("[data-today]");
    if (!button || button.disabled) return;
    var key = button.getAttribute("data-today");
    if (key === "speak") speakSummary();
    else loadSummary();
  });

  // Manage: clearing is two taps for everything, one for low priority, and always leaves a ledger line.
  var confirmTimer = null;

  function disarmClearAll() {
    clearTimeout(confirmTimer);
    confirmTimer = null;
    var button = manage.panel.querySelector('[data-clear="all"]');
    button.textContent = "Clear all";
    button.removeAttribute("data-armed");
  }

  function manageButtons(disabled, workingScope) {
    var buttons = manage.panel.querySelectorAll("[data-clear]");
    for (var i = 0; i < buttons.length; i++) {
      var scope = buttons[i].getAttribute("data-clear");
      buttons[i].disabled = disabled;
      if (workingScope === scope) buttons[i].textContent = "Clearing…";
      else if (!disabled) buttons[i].textContent = scope === "low" ? "Clear low priority" : "Clear all";
    }
  }

  function clearLog(scope) {
    manage.note.hidden = true;
    manageButtons(true, scope);

    fetch("/api/clear-log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: scope }) })
      .then(function (response) { return response.json(); })
      .catch(function () { return { ok: false, reason: "Could not reach Valey. Try again." }; })
      .then(function (result) {
        manageButtons(false);
        if (!(result && result.ok)) {
          manage.note.textContent = (result && result.reason) || "The log could not be cleared.";
          manage.note.hidden = false;
          return;
        }
        manage.panel.hidden = true;
        manage.toggle.setAttribute("aria-expanded", "false");
        lastFeedSig = null;
        if (!reducedMotion.matches) {
          var cards = feed.querySelectorAll(".card");
          for (var i = 0; i < cards.length; i++) cards[i].classList.add("leave");
        }
      });
  }

  manage.toggle.addEventListener("click", function () {
    var open = manage.panel.hidden;
    manage.panel.hidden = !open;
    manage.toggle.setAttribute("aria-expanded", open ? "true" : "false");
    manage.note.hidden = true;
    if (!open) disarmClearAll();
  });

  manage.panel.addEventListener("click", function (event) {
    var button = event.target.closest("[data-clear]");
    if (!button || button.disabled) return;
    var scope = button.getAttribute("data-clear");
    if (scope === "low") {
      disarmClearAll();
      clearLog("low");
      return;
    }
    if (button.getAttribute("data-armed") === "true") {
      disarmClearAll();
      clearLog("all");
      return;
    }
    button.textContent = "Confirm clear";
    button.setAttribute("data-armed", "true");
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(disarmClearAll, 3000);
  });

  // Pixel-based drawings follow the viewport.
  window.addEventListener("resize", function () {
    renderSpark(lastTimeline);
    if (lastData && lastData.stats) renderTiers(lastData.stats);
  });

  function poll() {
    fetch("/api/state", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then(function (data) {
        render(data);
        setStatus("ok");
      })
      .catch(function () {
        setStatus("stale");
      })
      .then(function () {
        restartPulse();
        setTimeout(poll, POLL_MS);
      });
  }

  today.toggle.querySelector(".chev").appendChild(icon("chevron"));
  pendingList.replaceChildren(pendingEmpty());
  feed.replaceChildren(feedEmpty());
  renderSpark([]);
  poll();
  setInterval(tick, TICK_MS);
})();

// Background threads: a woven strand of light rendered with raw WebGL2. Purely decorative,
// sits behind everything, takes no pointer input, and holds a single still frame under reduced motion.
(function () {
  "use strict";

  var OPTIONS = {
    color1: "#FFB020",
    color2: "#FF6B4A",
    color3: "#FFFFFF",
    speed: 0.2,
    threadCount: 6,
    frequency: 5.0,
    spread: 0.18,
    taper: 1.0,
    position: 0.5,
    fanMode: "center",
    glow: 0.02,
    falloff: 0.6,
    thickness: 1.1,
    brightness: 0.28,
    opacity: 0.5,
    mirror: true,
    shimmer: false,
    grain: true,
    grainIntensity: 0.05,
    mouseInteraction: true,
    mouseStrength: 0.3
  };
  var FAN_MODE = { center: 0, left: 1, right: 2 };
  var MAX_DPR = 1.5;

  var VERTEX = [
    "#version 300 es",
    "in vec2 position;",
    "void main() { gl_Position = vec4(position, 0.0, 1.0); }"
  ].join("\n");

  var FRAGMENT = [
    "#version 300 es",
    "precision highp float;",
    "uniform vec2 iResolution;",
    "uniform float iTime;",
    "uniform float uSpeed;",
    "uniform float uThreadCount;",
    "uniform float uFrequency;",
    "uniform float uSpread;",
    "uniform float uTaper;",
    "uniform float uPosition;",
    "uniform float uFanMode;",
    "uniform float uGlow;",
    "uniform float uFalloff;",
    "uniform float uThickness;",
    "uniform float uBrightness;",
    "uniform float uOpacity;",
    "uniform float uMirror;",
    "uniform float uShimmer;",
    "uniform float uGrain;",
    "uniform float uGrainIntensity;",
    "uniform vec3 uColor1;",
    "uniform vec3 uColor2;",
    "uniform vec3 uColor3;",
    "uniform vec2 uMouse;",
    "uniform float uMouseStrength;",
    "uniform float uEnableMouse;",
    "uniform float uMouseActive;",
    "out vec4 fragColor;",
    "#define TAU 6.28318530718",
    "#define MAX_THREADS 10",
    "float glow(float x, float str, float dist) { return dist / pow(max(x, 1e-4), str); }",
    "void main() {",
    "  vec2 uv = gl_FragCoord.xy / iResolution.xy;",
    "  float n = max(uThreadCount, 1.0);",
    "  float pinchX = uFanMode < 0.5 ? 0.5 : (uFanMode < 1.5 ? 0.0 : 1.0);",
    "  if (uEnableMouse > 0.5) { pinchX = mix(pinchX, uMouse.x, clamp(uMouseStrength, 0.0, 1.0) * uMouseActive); }",
    "  float spreadDx = uSpread * abs(uv.x - pinchX);",
    "  float baseT = iTime * uSpeed;",
    "  float tauOverN = TAU / n;",
    "  float mirror = uMirror > 0.5 ? sign(pinchX - uv.x) : 1.0;",
    "  bool doShimmer = uShimmer > 0.5;",
    "  float shimmerT = iTime * 1.7;",
    "  float invThickness = 1.0 / max(uThickness, 0.01);",
    "  float xFreq = uv.x * uFrequency;",
    "  float yOff = uv.y - uPosition;",
    "  float ciScale = n > 1.0 ? 1.0 / (n - 1.0) : 0.0;",
    "  vec3 col = vec3(0.0);",
    "  float gsum = 0.0;",
    "  for (int idx = 0; idx < MAX_THREADS; idx++) {",
    "    float i = float(idx);",
    "    if (i >= n) break;",
    "    float amplitude = spreadDx * (1.0 + i * uTaper);",
    "    float shimmer = doShimmer ? sin(shimmerT + i * 1.3) * 0.35 : 0.0;",
    "    float phase = (baseT + i * tauOverN) * mirror + shimmer;",
    "    float sdf = abs(yOff + sin(xFreq + phase) * amplitude) * invThickness;",
    "    float g = glow(sdf, uFalloff, uGlow);",
    "    vec3 threadCol = mix(uColor1, uColor2, i * ciScale);",
    "    col += g * threadCol;",
    "    gsum += g;",
    "  }",
    "  float coreAmt = smoothstep(0.5, 2.2, gsum);",
    "  col = mix(col, uColor3 * gsum, coreAmt * 0.5);",
    "  float bright = uBrightness;",
    "  if (uEnableMouse > 0.5) { vec2 md = uv - uMouse; bright += clamp(uMouseStrength, 0.0, 1.0) * uMouseActive * exp(-dot(md, md) * 6.0) * 0.6; }",
    "  col *= bright;",
    "  float alpha = clamp(gsum, 0.0, 1.0) * uOpacity;",
    "  vec3 outRgb = col * alpha;",
    "  if (uGrain > 0.5) {",
    "    float gv = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + iTime) * 43758.5453) - 0.5) * uGrainIntensity;",
    "    outRgb = clamp(outRgb + gv, 0.0, 1.0);",
    "    alpha = clamp(alpha + gv, 0.0, 1.0);",
    "  }",
    "  fragColor = vec4(outRgb, alpha);",
    "}"
  ].join("\n");

  function hexToRgb(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return [1, 1, 1];
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
  }

  function compile(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var canvas = document.createElement("canvas");
  canvas.className = "threads";
  canvas.setAttribute("aria-hidden", "true");
  var gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: "low-power" });
  if (!gl) return;

  var vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  var fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  if (!vs || !fs) return;
  var program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);

  var buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var positionLocation = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
  gl.clearColor(0, 0, 0, 0);

  var u = function (name) { return gl.getUniformLocation(program, name); };
  gl.uniform1f(u("uSpeed"), OPTIONS.speed);
  gl.uniform1f(u("uThreadCount"), Math.round(OPTIONS.threadCount));
  gl.uniform1f(u("uFrequency"), OPTIONS.frequency);
  gl.uniform1f(u("uSpread"), OPTIONS.spread);
  gl.uniform1f(u("uTaper"), OPTIONS.taper);
  gl.uniform1f(u("uPosition"), OPTIONS.position);
  gl.uniform1f(u("uFanMode"), FAN_MODE[OPTIONS.fanMode] || 0);
  gl.uniform1f(u("uGlow"), OPTIONS.glow);
  gl.uniform1f(u("uFalloff"), OPTIONS.falloff);
  gl.uniform1f(u("uThickness"), OPTIONS.thickness);
  gl.uniform1f(u("uBrightness"), OPTIONS.brightness);
  gl.uniform1f(u("uOpacity"), OPTIONS.opacity);
  gl.uniform1f(u("uMirror"), OPTIONS.mirror ? 1 : 0);
  gl.uniform1f(u("uShimmer"), OPTIONS.shimmer ? 1 : 0);
  gl.uniform1f(u("uGrain"), OPTIONS.grain && !reducedMotion.matches ? 1 : 0);
  gl.uniform1f(u("uGrainIntensity"), OPTIONS.grainIntensity);
  gl.uniform3fv(u("uColor1"), hexToRgb(OPTIONS.color1));
  gl.uniform3fv(u("uColor2"), hexToRgb(OPTIONS.color2));
  gl.uniform3fv(u("uColor3"), hexToRgb(OPTIONS.color3));
  gl.uniform1f(u("uMouseStrength"), OPTIONS.mouseStrength);
  gl.uniform1f(u("uEnableMouse"), OPTIONS.mouseInteraction ? 1 : 0);
  var iTimeLocation = u("iTime");
  var iResolutionLocation = u("iResolution");
  var mouseLocation = u("uMouse");
  var mouseActiveLocation = u("uMouseActive");

  document.body.insertBefore(canvas, document.body.firstChild);

  var currentMouse = [0.5, 0.5];
  var targetMouse = [0.5, 0.5];
  var currentActive = 0;
  var targetActive = 0;

  function draw(seconds) {
    currentMouse[0] += 0.05 * (targetMouse[0] - currentMouse[0]);
    currentMouse[1] += 0.05 * (targetMouse[1] - currentMouse[1]);
    currentActive += 0.05 * (targetActive - currentActive);
    gl.uniform1f(iTimeLocation, seconds);
    gl.uniform2f(mouseLocation, currentMouse[0], currentMouse[1]);
    gl.uniform1f(mouseActiveLocation, currentActive);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(iResolutionLocation, canvas.width, canvas.height);
    if (reducedMotion.matches) draw(0);
  }

  window.addEventListener("pointermove", function (event) {
    if (event.pointerType !== "mouse") return;
    targetMouse[0] = event.clientX / window.innerWidth;
    targetMouse[1] = 1 - event.clientY / window.innerHeight;
    targetActive = 1;
  });
  document.addEventListener("mouseleave", function () { targetActive = 0; });

  var raf = 0;
  var start = performance.now();

  function loop(now) {
    draw((now - start) * 0.001);
    raf = requestAnimationFrame(loop);
  }

  function play() {
    if (reducedMotion.matches || document.hidden || raf) return;
    raf = requestAnimationFrame(loop);
  }

  function pause() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", function () { if (document.hidden) pause(); else play(); });
  reducedMotion.addEventListener("change", function () { pause(); resize(); play(); });

  resize();
  play();
})();
