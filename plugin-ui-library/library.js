// Small interactions make the catalog specimens explorable without invoking plugin APIs.
const map = document.querySelector('#mapGrid');
const heights = [
  [0.4,0.2,0.1,-0.1,-0.2,-0.1,0.0,0.2,0.4],
  [0.3,0.1,-0.1,-0.3,-0.2,-0.1,0.1,0.3,0.5],
  [0.2,0.0,-0.2,-0.4,-0.3,-0.1,0.2,0.4,0.6],
  [0.1,-0.1,-0.2,-0.3,-0.1,0.1,0.3,0.5,0.7],
  [0.0,-0.1,-0.1,0.1,0.3,0.4,0.5,0.6,0.6],
  [-0.1,0.0,0.1,0.3,0.4,0.5,0.6,0.5,0.4],
  [-0.2,0.1,0.3,0.4,0.5,0.4,0.3,0.2,0.1]
];
for (const row of heights) for (const value of row) {
  const cell = document.createElement('span');
  cell.className = 'map-cell';
  cell.style.setProperty('--height', value);
  cell.style.setProperty('--hue', Math.round(220 - ((value + 0.42) / 1.1) * 220));
  map.append(cell);
}

document.querySelectorAll('[data-select]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll(`[data-select="${button.dataset.select}"]`).forEach(peer => peer.classList.remove('selected'));
  button.classList.add('selected');
}));

document.querySelectorAll('input[name="origin"]').forEach(input => input.addEventListener('change', () => {
  document.querySelector('#originReadout').innerHTML = `Selected origin: <strong>${input.value}</strong>`;
}));

document.querySelector('#exaggeration').addEventListener('input', event => {
  document.querySelector('#exaggerationOutput').value = `${event.target.value}×`;
  const scale = Number(event.target.value);
  map.querySelectorAll('.map-cell').forEach((cell, index) => {
    const raw = heights[Math.floor(index / 9)][index % 9];
    cell.style.filter = `brightness(${Math.max(.65, Math.min(1.2, 1 + raw * scale * .08))})`;
  });
});

document.querySelector('#droMode').addEventListener('click', event => {
  event.currentTarget.textContent = event.currentTarget.textContent === 'WPOS' ? 'MPOS' : 'WPOS';
});
document.querySelector('#homeButton').addEventListener('click', () => {
  document.querySelector('#homeState').textContent = 'Preview: homing requested';
});

const sections = [...document.querySelectorAll('.specimen-section, #foundation')];
const links = [...document.querySelectorAll('#componentNav a')];
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    links.forEach(link => link.classList.toggle('active', link.hash === `#${entry.target.id}`));
  }
}, { rootMargin: '-15% 0px -70% 0px' });
sections.forEach(section => observer.observe(section));
