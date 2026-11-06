const snippets = window.FUNCTION_SNIPPETS ?? [];
const nav = document.querySelector('#codeNav');
const host = document.querySelector('#codeSections');
const categories = [...new Set(snippets.map((item) => item.category))];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

for (const category of categories) {
  const id = snippets.find((item) => item.category === category).id;
  const link = document.createElement('a');
  link.href = `#${id}`;
  link.textContent = category;
  nav.append(link);

  const section = document.createElement('section');
  section.className = 'code-category';
  section.id = id;
  const blocks = snippets.filter((item) => item.category === category);
  section.innerHTML = `<div class="code-category-heading"><div><div class="eyebrow">FUNCTION SET · ${String(categories.indexOf(category) + 1).padStart(2, '0')}</div><h2>${escapeHtml(category)}</h2></div><p>${blocks.length} source ${blocks.length === 1 ? 'block' : 'blocks'}</p></div>`;
  for (const item of blocks) {
    const card = document.createElement('details');
    card.className = 'code-card';
    const source = item.path
      ? `<a href="../${escapeHtml(item.path)}#L${item.line}" target="_blank" rel="noreferrer">Source: ${escapeHtml(item.path)} · line ${item.line} ↗</a>`
      : `<span>${escapeHtml(item.sourceLabel ?? 'Reusable pattern')}</span>`;
    const lines = item.code.split('\n').length;
    card.innerHTML = `<summary><span class="code-card-title">${escapeHtml(item.title)}</span><span class="code-card-summary">${escapeHtml(item.description)}</span></summary>
      <div class="code-card-body">
        <div class="code-meta">${source}<div class="code-toolbar"><span class="code-line-count">${lines} lines</span><button class="copy-code" type="button">Copy code</button><span class="copy-state" aria-live="polite"></span></div></div>
        <p class="code-requires"><b>Needs:</b> ${escapeHtml(item.requires)}</p>
        <pre class="code-frame"><code>${escapeHtml(item.code)}</code></pre>
      </div>`;
    const button = card.querySelector('.copy-code');
    const status = card.querySelector('.copy-state');
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.code);
        status.textContent = 'Copied';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(card.querySelector('code'));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        status.textContent = 'Select and copy';
      }
      window.setTimeout(() => { status.textContent = ''; }, 2200);
    });
    section.append(card);
  }
  host.append(section);
}

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting) {
    [...nav.querySelectorAll('a')].forEach((link) => link.classList.toggle('active', link.hash === `#${entry.target.id}`));
  }
}, { rootMargin: '-15% 0px -70% 0px' });
document.querySelectorAll('.code-category').forEach((section) => observer.observe(section));
