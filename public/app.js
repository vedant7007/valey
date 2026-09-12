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
    tray: document.getElementById("tray-icon")
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

  function decisionCard(entry) {
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
      if (!firstRender && fresh[keyOf(items[i])]) node.classList.add(animClass);
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

  function renderFeed(decisions, fresh) {
    var visible = [];
    for (var i = 0; i < decisions.length; i++) {
      if (!sourceFilter || decisions[i].source === sourceFilter) visible.push(decisions[i]);
    }
    var sig = sourceFilter + "|" + JSON.stringify(visible);
    if (sig === lastFeedSig) return;
    lastFeedSig = sig;
    renderList(feed, visible, function (d) { return d.id; }, decisionCard, fresh, "flash", feedEmpty);
    document.getElementById("feed-count").textContent = visible.length ? String(visible.length) : "";
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

  pendingList.replaceChildren(pendingEmpty());
  feed.replaceChildren(feedEmpty());
  renderSpark([]);
  poll();
  setInterval(tick, TICK_MS);
})();
