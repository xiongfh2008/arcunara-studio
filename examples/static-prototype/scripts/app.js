// 原型示例脚本：证明外部 JS 在发布与预览链路中可用。
document.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("status");
  if (el) {
    el.textContent = "脚本已加载 ✓ " + new Date().toLocaleString();
  }
});
