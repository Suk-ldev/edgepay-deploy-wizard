document.querySelectorAll('[data-copy]').forEach((button) => {
  button.type = 'button';
  button.setAttribute('aria-label', '复制此代码块');
  button.setAttribute('aria-live', 'polite');
  button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(button.nextElementSibling.textContent);
      button.textContent = '已复制';
    } catch {
      button.textContent = '请手动复制';
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(button.nextElementSibling);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setTimeout(() => { button.textContent = '复制'; }, 2000);
  };
});

const links = [...document.querySelectorAll('#guide-nav a')];
const sections = links.map((link) => document.querySelector(link.hash));
let pending = false;
function updateLocation() {
  const current = sections.filter((section) => section.getBoundingClientRect().top <= 140).at(-1) || sections[0];
  links.forEach((link) => {
    if (link.hash === '#' + current.id) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
  pending = false;
}
addEventListener('scroll', () => {
  if (!pending) { pending = true; requestAnimationFrame(updateLocation); }
}, { passive: true });
updateLocation();
