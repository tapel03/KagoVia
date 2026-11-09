/* AI Design page: plan options, zoom, chat composer with file
   attachments, and export to Word / PowerPoint / Excel / image. */
(function () {
    "use strict";

    var $ = function (id) { return document.getElementById(id); };
    var planTitle = $("planTitle");
    var planMeta = $("planMeta");
    var messages = $("chatMessages");
    var form = $("chatForm");
    var input = $("chatInput");
    var sendBtn = $("sendBtn");
    var note = $("composerNote");
    var attachList = $("attachList");
    var fileInput = $("fileInput");
    var AI_ICON = document.querySelector(".ai-chat-avatar").innerHTML;

    var MAX_WORDS = 1000;            // typed text up to this goes in the message
    var MAX_FILES = 5;
    var MAX_FILE_BYTES = 10 * 1024 * 1024;
    var currentOption = "A";
    var files = [];                  // {file, name, size, generated}
    var history = [];                // {who, text, files}

    /* ---------- toast ---------- */
    var toastEl = $("aiToast"), toastTimer;
    function toast(msg) {
        toastEl.textContent = msg;
        toastEl.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2600);
    }

    /* ---------- house details ---------- */
    var brief = { beds: $("briefBeds"), baths: $("briefBaths"), size: $("briefSize"), storeys: $("briefStoreys") };
    function briefText() {
        return brief.beds.value + " beds, " + brief.baths.value + " baths, " + brief.size.value + ", " + brief.storeys.value.toLowerCase();
    }
    function updateMeta() { planMeta.textContent = briefText(); }
    Object.keys(brief).forEach(function (k) { brief[k].addEventListener("change", updateMeta); });
    updateMeta();

    /* ---------- design tabs ---------- */
    function selectOption(key) {
        currentOption = key;
        document.querySelectorAll(".design-tab[data-design]").forEach(function (tab) {
            var on = tab.dataset.design === key;
            tab.classList.toggle("active", on);
            tab.setAttribute("aria-selected", on ? "true" : "false");
        });
        planTitle.textContent = "Option " + key;
    }
    document.querySelectorAll(".design-tab[data-design]").forEach(function (tab) {
        tab.addEventListener("click", function () { selectOption(tab.dataset.design); });
    });
    $("generateMoreBtn").addEventListener("click", function () { send("Generate more layout options", []); });

    /* ---------- 2D / 3D ---------- */
    var stage = $("floorplanStage");
    var view3d = $("floorplan3d");
    document.querySelectorAll(".fp-toggle").forEach(function (btn) {
        btn.addEventListener("click", function () {
            document.querySelectorAll(".fp-toggle").forEach(function (b) {
                b.classList.toggle("active", b === btn);
                b.setAttribute("aria-pressed", b === btn ? "true" : "false");
            });
            var is3d = btn.dataset.view === "3d";
            stage.hidden = is3d;
            view3d.hidden = !is3d;
        });
    });

    /* ---------- zoom + full screen ---------- */
    var zoom = 1;
    var zoomValue = $("zoomValue");
    function setZoom(z) {
        zoom = Math.min(2, Math.max(0.5, Math.round(z * 10) / 10));
        stage.style.transform = "scale(" + zoom + ")";
        zoomValue.textContent = Math.round(zoom * 100) + "%";
    }
    $("zoomInBtn").addEventListener("click", function () { setZoom(zoom + 0.1); });
    $("zoomOutBtn").addEventListener("click", function () { setZoom(zoom - 0.1); });
    var canvas = $("floorplanCanvas");
    $("fullscreenBtn").addEventListener("click", function () {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (canvas.requestFullscreen) canvas.requestFullscreen();
    });

    /* ---------- save ---------- */
    $("saveBtn").addEventListener("click", function () {
        toast("Option " + currentOption + " saved to your project");
    });

    /* ---------- chat rendering (DOM only, no HTML from user text) ---------- */
    function scrollToEnd() { messages.scrollTop = messages.scrollHeight; }

    function fmtSize(n) {
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
        return (n / 1024 / 1024).toFixed(1) + " MB";
    }

    function fileChip(f, removable, index) {
        var li = document.createElement("li");
        li.className = "attach-chip";
        var ext = (f.name.split(".").pop() || "").slice(0, 4).toUpperCase();
        var badge = document.createElement("span");
        badge.className = "attach-ext";
        badge.textContent = ext;
        var name = document.createElement("span");
        name.className = "attach-name";
        name.textContent = f.name;
        name.title = f.name;
        var size = document.createElement("span");
        size.className = "attach-size";
        size.textContent = fmtSize(f.size);
        li.appendChild(badge);
        li.appendChild(name);
        li.appendChild(size);
        if (removable) {
            var x = document.createElement("button");
            x.type = "button";
            x.className = "attach-remove";
            x.setAttribute("aria-label", "Remove " + f.name);
            x.dataset.i = index;
            x.textContent = "×";
            li.appendChild(x);
        }
        return li;
    }

    function addUser(text, atts) {
        var el = document.createElement("div");
        el.className = "chat-msg chat-msg--user";
        if (text) {
            text.split(/\n{2,}/).forEach(function (para) {
                var p = document.createElement("p");
                p.textContent = para;
                el.appendChild(p);
            });
        }
        if (atts && atts.length) {
            var ul = document.createElement("ul");
            ul.className = "attach-list attach-list--sent";
            atts.forEach(function (f) { ul.appendChild(fileChip(f, false)); });
            el.appendChild(ul);
        }
        messages.appendChild(el);
        scrollToEnd();
    }

    function addAi(paragraphs, noteText) {
        var el = document.createElement("div");
        el.className = "chat-msg chat-msg--ai";
        var av = document.createElement("span");
        av.className = "chat-msg-avatar";
        av.innerHTML = AI_ICON; // static icon markup from the page itself
        var body = document.createElement("div");
        body.className = "chat-msg-body";
        el.appendChild(av);
        el.appendChild(body);
        messages.appendChild(el);
        if (paragraphs) fillAi(body, paragraphs, noteText);
        scrollToEnd();
        return body;
    }

    function fillAi(body, paragraphs, noteText) {
        body.textContent = "";
        paragraphs.forEach(function (t) {
            var p = document.createElement("p");
            p.textContent = t;
            body.appendChild(p);
        });
        if (noteText) {
            var n = document.createElement("p");
            n.className = "chat-msg-note";
            n.textContent = noteText;
            body.appendChild(n);
        }
    }

    function addTyping() {
        var body = addAi(null);
        var t = document.createElement("span");
        t.className = "typing";
        t.setAttribute("aria-label", "Assistant is typing");
        t.innerHTML = "<i></i><i></i><i></i>";
        body.appendChild(t);
        return body;
    }

    // Demo replies. Swap for the backend AI service (POST /v1/generations) when wired.
    function demoReply(text, atts) {
        var t = text.toLowerCase();
        var out = [];
        if (t.indexOf("more") >= 0 && t.indexOf("option") >= 0) {
            out.push("I've refreshed the layout options for " + briefText() + ". Pick Option A, B or C above the plan to compare them.");
        } else {
            out.push("Got it. I've updated Option " + currentOption + " (" + briefText() + ") with that change. Check the plan, and tell me if you want anything adjusted.");
        }
        if (atts.length) {
            out.push("I received " + atts.length + " file" + (atts.length === 1 ? "" : "s") + ": " + atts.map(function (f) { return f.name; }).join(", ") + ". I'll use " + (atts.length === 1 ? "it" : "them") + " as reference for the layout.");
        }
        return out;
    }

    function send(text, atts) {
        text = (text || "").trim();
        if (!text && !atts.length) return;
        addUser(text, atts);
        history.push({ who: "You", text: text, files: atts.map(function (f) { return f.name; }) });
        var typing = addTyping();
        setTimeout(function () {
            var reply = demoReply(text, atts);
            fillAi(typing, reply, "Demo reply: the AI service is not connected yet.");
            history.push({ who: "AI", text: reply.join(" "), files: [] });
            scrollToEnd();
        }, 700);
    }

    /* ---------- composer ---------- */
    function wordCount(s) {
        var m = s.trim().match(/\S+/g);
        return m ? m.length : 0;
    }

    function setNote(msg, warn) {
        note.textContent = msg || "";
        note.classList.toggle("warn", !!warn);
    }

    function renderFiles() {
        attachList.textContent = "";
        files.forEach(function (f, i) { attachList.appendChild(fileChip(f, true, i)); });
        attachList.hidden = files.length === 0;
    }

    function addFile(file, generated) {
        if (files.length >= MAX_FILES) { setNote("You can attach up to " + MAX_FILES + " files.", true); return false; }
        if (file.size > MAX_FILE_BYTES) { setNote(file.name + " is larger than 10 MB.", true); return false; }
        files.push({ file: file, name: file.name, size: file.size, generated: !!generated });
        renderFiles();
        return true;
    }

    // Long text becomes a .txt attachment so the message stays readable
    function textToFile(text) {
        var n = 1;
        files.forEach(function (f) { if (/^description(-\d+)?\.txt$/.test(f.name)) n++; });
        var name = n === 1 ? "description.txt" : "description-" + n + ".txt";
        var file = new File([text], name, { type: "text/plain" });
        return addFile(file, true);
    }

    function updateComposer() {
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 220) + "px";
        if (wordCount(input.value) > MAX_WORDS) {
            setNote("Long description: it will be sent as a text file.", false);
        } else if (note.classList.contains("warn") === false) {
            setNote("");
        }
    }

    input.addEventListener("input", updateComposer);

    // Pasting a very long block turns it straight into a text file
    input.addEventListener("paste", function (e) {
        var text = (e.clipboardData || window.clipboardData).getData("text");
        if (wordCount(text) > MAX_WORDS) {
            e.preventDefault();
            if (textToFile(text)) setNote("Your pasted text was long, so it was added as description.txt.");
        }
    });

    input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            form.requestSubmit();
        }
    });

    $("attachBtn").addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () {
        setNote("");
        Array.prototype.forEach.call(fileInput.files, function (f) { addFile(f); });
        fileInput.value = "";
    });
    attachList.addEventListener("click", function (e) {
        var b = e.target.closest(".attach-remove");
        if (!b) return;
        files.splice(+b.dataset.i, 1);
        renderFiles();
        setNote("");
        input.focus();
    });

    // Drag and drop onto the message box
    var box = $("composerBox");
    ["dragenter", "dragover"].forEach(function (ev) {
        box.addEventListener(ev, function (e) { e.preventDefault(); box.classList.add("drag"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
        box.addEventListener(ev, function (e) { e.preventDefault(); box.classList.remove("drag"); });
    });
    box.addEventListener("drop", function (e) {
        Array.prototype.forEach.call(e.dataTransfer.files || [], function (f) { addFile(f); });
    });

    form.addEventListener("submit", function (e) {
        e.preventDefault();
        var text = input.value.trim();
        if (!text && !files.length) {
            setNote("Describe your house or attach a file first.", true);
            input.focus();
            return;
        }
        if (wordCount(text) > MAX_WORDS) {
            if (!textToFile(text)) return;
            text = "My full description is in the attached text file.";
        }
        var atts = files.slice();
        var details = "(" + briefText() + ")";
        send(text ? text + "\n\n" + details : details, atts);
        input.value = "";
        files = [];
        renderFiles();
        setNote("");
        updateComposer();
        $("sendLabel").textContent = "Send";
    });

    // Suggestion cards drop their text into the message box, ready to edit or send
    messages.addEventListener("click", function (e) {
        var s = e.target.closest(".chat-suggestion");
        if (!s) return;
        input.value = s.dataset.prompt;
        updateComposer();
        input.focus();
    });

    /* ---------- export ---------- */
    function rooms() {
        // Room schedule read from the plan drawing: label + size where shown
        var svg = stage.querySelector("svg");
        var texts = Array.prototype.slice.call(svg.querySelectorAll("text"));
        var out = [];
        texts.forEach(function (t, i) {
            var label = t.textContent.trim();
            if (/^\d/.test(label)) return; // a dimension, not a room
            var next = texts[i + 1];
            var size = next && /^\d/.test(next.textContent.trim()) ? next.textContent.trim().replace(/\s*x\s*/i, " × ") : "See plan";
            out.push([label.charAt(0) + label.slice(1).toLowerCase(), size]);
        });
        return out;
    }

    function baseName() {
        return "kagobuild-design-option-" + currentOption.toLowerCase();
    }

    function chatRows() {
        return history.map(function (h) { return [h.who, h.text, h.files.join(", ")]; });
    }

    function exportPlan(fmt) {
        var svg = stage.querySelector("svg");
        var title = "House design, Option " + currentOption;
        var summary = briefText();
        var r = rooms();

        if (fmt === "xlsx") {
            var sheets = [
                { name: "Rooms", cols: ["Room", "Size"], rows: r },
                { name: "Design brief", cols: ["Item", "Value"], rows: [
                    ["Option", currentOption], ["Bedrooms", brief.beds.value], ["Bathrooms", brief.baths.value],
                    ["Floor area", brief.size.value], ["Storeys", brief.storeys.value]
                ] }
            ];
            if (history.length) sheets.push({ name: "Chat", cols: ["From", "Message", "Files"], rows: chatRows() });
            OfficeExport.xlsx(baseName(), { title: title, sheets: sheets });
            toast("Excel file downloaded");
            return;
        }

        if (fmt === "svg") {
            var clone = svg.cloneNode(true);
            clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
            OfficeExport.saveBlob(baseName() + ".svg", new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
            toast("SVG plan downloaded");
            return;
        }

        return OfficeExport.svgToPng(svg, 1800).then(function (img) {
            if (fmt === "png") {
                OfficeExport.saveBlob(baseName() + ".png", img.blob);
                toast("Plan image downloaded");
                return;
            }
            if (fmt === "docx") {
                var blocks = [
                    { h: "Floor plan" }, { image: img },
                    { p: "AI-generated concept design. Verify dimensions and consult registered professionals before building." },
                    { h: "Design brief" },
                    { table: { cols: ["Item", "Value"], rows: [["Bedrooms", brief.beds.value], ["Bathrooms", brief.baths.value], ["Floor area", brief.size.value], ["Storeys", brief.storeys.value]] } },
                    { h: "Rooms" }, { table: { cols: ["Room", "Size"], rows: r } }
                ];
                if (history.length) blocks.push({ h: "Design conversation" }, { table: { cols: ["From", "Message", "Files"], rows: chatRows() } });
                OfficeExport.docx(baseName(), { title: title, subtitle: summary, blocks: blocks });
                toast("Word document downloaded");
                return;
            }
            if (fmt === "pptx") {
                OfficeExport.pptx(baseName(), { title: title, subtitle: summary, slides: [
                    { title: "Floor plan", image: img },
                    { title: "Design brief", bullets: ["Bedrooms: " + brief.beds.value, "Bathrooms: " + brief.baths.value, "Floor area: " + brief.size.value, "Storeys: " + brief.storeys.value, "Concept design only: verify with a registered professional"] },
                    { title: "Rooms", table: { cols: ["Room", "Size"], rows: r } }
                ] });
                toast("PowerPoint downloaded");
            }
        }).catch(function () { toast("Export failed. Please try again."); });
    }

    OfficeExport.menu($("exportBtn"), [
        { fmt: "docx", label: "Word document", hint: "Plan, brief and room list", run: exportPlan },
        { fmt: "pptx", label: "PowerPoint slides", hint: "Present the design", run: exportPlan },
        { fmt: "xlsx", label: "Excel room schedule", hint: "Rooms and sizes", run: exportPlan },
        { fmt: "png", badge: "img", label: "Image (PNG)", hint: "Share or print the plan", run: exportPlan },
        { fmt: "svg", badge: "svg", label: "Vector drawing (SVG)", hint: "Sharp at any size", run: exportPlan }
    ]);

    scrollToEnd();
})();
