// ---- Site settings ----
const PRICE = '$12.99';               // keep in sync with the price set in Paddle
const PADDLE_TOKEN = 'live_235420c889bd31b53a07951c584';   // client-side token, safe to publish
const PADDLE_PRICE_ID = 'pri_01m3cnmvbdeb542pmtxvrdm919';

document.querySelectorAll('[data-price]').forEach(el => { el.textContent = PRICE; });

// ---- Checkout: Buy -> Paddle overlay -> /download ----
// If Paddle.js fails to load, the buttons keep their #order link as a fallback.
if (window.Paddle) {
  Paddle.Initialize({
    token: PADDLE_TOKEN,
    eventCallback: e => {
      if (e.name === 'checkout.completed' && e.data && e.data.transaction_id) {
        location.href = '/download?txn=' + encodeURIComponent(e.data.transaction_id);
      }
    },
  });
  document.querySelectorAll('[data-buy]').forEach(btn => btn.addEventListener('click', e => {
    e.preventDefault();
    Paddle.Checkout.open({
      items: [{ priceId: PADDLE_PRICE_ID, quantity: 1 }],
      settings: { displayMode: 'overlay', variant: 'one-page' },
    });
  }));
}

const book = window.BOOK || [];
const all = book.flatMap(ch => ch.recipes.map(r => ({ ...r, chapter: ch.n })));
const range = s => s.match(/\d+/g).map(Number);
const fmt = n => '$' + Math.round(n).toLocaleString('en-US');
const tagsOf = r => r.tag.split(/\s*(?:\/|OR)\s*/);

// ---- Ledger: a few rows straight from the book ----
const picks = [
  'Chicken Soup with Matzo Balls',
  'Onion-Braised Brisket',
  'Slow Cholent with Barley, Beans & Beef',
  'Crisp Potato Latkes',
  'Cheese Blintzes',
  'Challah Bread Pudding',
];
document.getElementById('ledger-rows').innerHTML = picks
  .map(name => all.find(r => r.name === name))
  .filter(Boolean)
  .map(r => `
    <div class="ledger__row">
      <span>${r.name}<small>${r.meta.split(' · ')[0]}</small></span>
      <span>${r.home.replace('-', '–')}</span>
      <span>${r.out.replace('-', '–')}</span>
      <span class="diff">${r.diff.replace('-', '–')}</span>
    </div>`).join('');

// ---- Calculator: average supper difference from the book's own ranges ----
const suppers = all.filter(r => /Serves [4-9]|Serves 1\d/.test(r.meta) && ![1, 15].includes(r.chapter));
const avgLo = suppers.reduce((s, r) => s + range(r.diff)[0], 0) / suppers.length;
const avgHi = suppers.reduce((s, r) => s + range(r.diff)[1], 0) / suppers.length;
const slider = document.getElementById('calc-range');
const updateCalc = () => {
  const n = Number(slider.value);
  document.getElementById('calc-n').textContent = n;
  document.getElementById('calc-year').textContent = `${fmt(avgLo * n * 52)} – ${fmt(avgHi * n * 52)}`;
};
slider.addEventListener('input', updateCalc);
updateCalc();

// ---- Chapters + filter ----
const chaptersEl = document.getElementById('chapters');
chaptersEl.innerHTML = book.map(ch => `
  <article class="card chapter reveal">
    <span class="chapter__n">Chapter ${ch.n}</span>
    <h3>${ch.title}</h3>
    <p class="chapter__sub">${ch.sub}</p>
    <ul>
      ${ch.recipes.map(r => `
        <li data-tags="${tagsOf(r).join(' ')}${r.leftovers ? ' LEFT' : ''}">
          <span>${r.name}${tagsOf(r).map(t => `<span class="tag tag--${t}">${t}</span>`).join('')}</span>
          <b>${r.home.replace('-', '–')}</b>
        </li>`).join('')}
    </ul>
  </article>`).join('');

document.querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => {
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('is-on', c === chip));
  const tag = chip.dataset.tag;
  chaptersEl.querySelectorAll('.chapter').forEach(card => {
    let shown = 0;
    card.querySelectorAll('li').forEach(li => {
      const ok = tag === 'ALL' || li.dataset.tags.split(' ').includes(tag);
      li.classList.toggle('is-hidden', !ok);
      shown += ok;
    });
    card.classList.toggle('is-empty', shown === 0);
  });
}));

// ---- Scroll reveal ----
const io = 'IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches
  ? new IntersectionObserver(entries => entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
    }), { threshold: 0.12, rootMargin: '0px 0px -40px 0px' })
  : null;
document.querySelectorAll('.reveal').forEach(el => io ? io.observe(el) : el.classList.add('is-in'));
