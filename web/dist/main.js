"use strict";
const title = document.querySelector("#title");
const blocks = document.querySelector("#blocks");
const saveStatus = document.querySelector("#status");
let note = null;
let saveTimer;
function readBlocks() {
    return [...blocks.querySelectorAll("[data-block]")].map((element) => ({
        type: element.dataset.type,
        text: element.querySelector(".block-text").innerText,
        checked: (element.querySelector("input[type=checkbox]"))?.checked
    }));
}
function render(content) {
    blocks.innerHTML = "";
    (content.length ? content : [{ type: "paragraph", text: "" }]).forEach((block) => addBlock(block));
    focusLast();
}
function addBlock(block = { type: "paragraph", text: "" }) {
    const row = document.createElement("div");
    row.className = "block";
    row.dataset.block = "true";
    row.dataset.type = block.type;
    row.innerHTML = block.type === "todo"
        ? `<input type="checkbox" ${block.checked ? "checked" : ""}><div class="block-text" contenteditable="true"></div>`
        : `<div class="grip">⋮⋮</div><div class="block-text ${block.type === "heading" ? "heading" : ""}" contenteditable="true"></div>`;
    row.querySelector(".block-text").innerText = block.text;
    row.addEventListener("input", scheduleSave);
    row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            addBlock();
            focusLast();
            scheduleSave();
        }
        if (event.key === "Backspace" && !event.target.innerText && blocks.children.length > 1) {
            event.preventDefault();
            row.remove();
            focusLast();
            scheduleSave();
        }
    });
    row.querySelector("input")?.addEventListener("change", scheduleSave);
    blocks.append(row);
}
function focusLast() { blocks.lastElementChild?.querySelector(".block-text")?.focus(); }
function scheduleSave() { saveStatus.textContent = "正在保存..."; window.clearTimeout(saveTimer); saveTimer = window.setTimeout(save, 450); }
function save() {
    if (!note)
        return;
    const message = JSON.stringify({ type: "save-note", title: title.value.trim() || "未命名笔记", content: readBlocks() });
    const bridge = window.chrome?.webview;
    const legacyBridge = window.external;
    if (bridge)
        bridge.postMessage(message);
    else if (legacyBridge?.postMessage)
        legacyBridge.postMessage(message);
    else if (legacyBridge?.sendMessage)
        legacyBridge.sendMessage(message);
    else {
        saveStatus.textContent = "浏览器桥接不可用";
        return;
    }
    saveStatus.textContent = "已保存";
}
window.addEventListener("message", (event) => {
    const message = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    if (message.type !== "load-note")
        return;
    note = message.note;
    title.value = note.title;
    render(JSON.parse(note.contentJson || "[]"));
    saveStatus.textContent = "本地笔记";
});
document.querySelector("#add-paragraph").addEventListener("click", () => { addBlock(); focusLast(); });
document.querySelector("#add-heading").addEventListener("click", () => { addBlock({ type: "heading", text: "" }); focusLast(); });
document.querySelector("#add-todo").addEventListener("click", () => { addBlock({ type: "todo", text: "" }); focusLast(); });
title.addEventListener("input", scheduleSave);
