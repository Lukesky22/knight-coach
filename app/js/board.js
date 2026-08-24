// Dependency-free chess board renderer: 64 squares, SVG piece images,
// last-move highlights, and an SVG overlay for coach arrows.

const FILES = 'abcdefgh';

export class Board {
  constructor(el) {
    this.el = el;
    this.flip = false;
    this.fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    this.lastMove = null; // [from, to]
    this.arrows = [];     // [{from, to, kind: 'best'|'played'}]

    // Interaction, off by default: the replay board is display-only, the
    // trainer board lets you play a move.
    this.interactive = false;
    this.legalFrom = null;   // (square) => [destination squares]
    this.onMove = null;      // ({from, to}) => void
    this.selected = null;

    el.classList.add('board');
    this.squares = {};
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const sq = document.createElement('div');
        sq.className = `sq ${(row + col) % 2 ? 'dark' : 'light'}`;
        sq.dataset.row = row;
        sq.dataset.col = col;
        el.appendChild(sq);
        this.squares[`${row},${col}`] = sq;
      }
    }

    el.addEventListener('click', (e) => {
      if (!this.interactive) return;
      const cell = e.target.closest('.sq');
      if (!cell) return;
      this.handleClick(this.squareAt(+cell.dataset.row, +cell.dataset.col));
    });
    this.pieceLayer = document.createElement('div');
    this.pieceLayer.className = 'piece-layer';
    el.appendChild(this.pieceLayer);
    // square -> {el, code}, kept between renders so a piece that moves is the
    // same DOM node and CSS can slide it instead of blinking
    this.pieceEls = new Map();

    this.overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.overlay.setAttribute('viewBox', '0 0 8 8');
    this.overlay.classList.add('arrow-layer');
    el.appendChild(this.overlay);
  }

  setFlip(flip) {
    this.flip = flip;
    this.render();
  }

  // sq "e4" -> {row, col} in display coordinates (0,0 = top-left)
  coords(sq) {
    const file = FILES.indexOf(sq[0]);
    const rank = parseInt(sq[1], 10) - 1;
    return this.flip
      ? { row: rank, col: 7 - file }
      : { row: 7 - rank, col: file };
  }

  // the inverse: display coordinates -> "e4"
  squareAt(row, col) {
    return this.flip
      ? `${FILES[7 - col]}${row + 1}`
      : `${FILES[col]}${8 - row}`;
  }

  setInteractive(on, { legalFrom, onMove } = {}) {
    this.interactive = on;
    this.el.classList.toggle('interactive', on);
    if (legalFrom) this.legalFrom = legalFrom;
    if (onMove) this.onMove = onMove;
    this.selected = null;
    this.render();
  }

  handleClick(sq) {
    // second click: if it completes a legal move, play it
    if (this.selected) {
      const dests = this.legalFrom ? this.legalFrom(this.selected) : [];
      if (dests.includes(sq)) {
        const from = this.selected;
        this.selected = null;
        this.render();
        if (this.onMove) this.onMove({ from, to: sq });
        return;
      }
    }
    // otherwise treat it as picking up a piece (or clearing the selection)
    const canMove = this.legalFrom && this.legalFrom(sq).length > 0;
    this.selected = canMove && sq !== this.selected ? sq : null;
    this.render();
  }

  position(fen, { lastMove = null, arrows = [] } = {}) {
    this.fen = fen;
    this.lastMove = lastMove;
    this.arrows = arrows;
    this.render();
  }

  render() {
    for (const sq of Object.values(this.squares)) {
      sq.classList.remove('hl', 'sel', 'dest');
    }
    if (this.lastMove) {
      for (const s of this.lastMove) {
        const { row, col } = this.coords(s);
        this.squares[`${row},${col}`].classList.add('hl');
      }
    }
    if (this.selected) {
      const s = this.coords(this.selected);
      this.squares[`${s.row},${s.col}`].classList.add('sel');
      for (const d of this.legalFrom(this.selected)) {
        const c = this.coords(d);
        this.squares[`${c.row},${c.col}`].classList.add('dest');
      }
    }

    // rank numbers down the left edge, file letters along the bottom
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const sq = this.squares[`${row},${col}`];
        const name = this.squareAt(row, col);
        sq.dataset.rank = col === 0 ? name[1] : '';
        sq.dataset.file = row === 7 ? name[0] : '';
      }
    }

    // Work out where every piece belongs, then reconcile against what is
    // already on screen so moving pieces keep their element and animate.
    const wanted = new Map(); // square -> code like "wN"
    const rows = this.fen.split(' ')[0].split('/');
    for (let r = 0; r < 8; r++) { // r=0 is rank 8
      let file = 0;
      for (const ch of rows[r]) {
        if (/\d/.test(ch)) { file += parseInt(ch, 10); continue; }
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        wanted.set(`${FILES[file]}${8 - r}`, color + ch.toUpperCase());
        file++;
      }
    }

    const place = (el, square) => {
      const { row, col } = this.coords(square);
      el.style.transform = `translate(${col * 100}%, ${row * 100}%)`;
    };

    // 1. drop pieces that are no longer anywhere they used to be
    const leftovers = [];
    for (const [square, entry] of this.pieceEls) {
      if (wanted.get(square) === entry.code) continue;
      this.pieceEls.delete(square);
      leftovers.push(entry);
    }
    // 2. fill squares that need a piece, reusing a matching orphan when we can
    for (const [square, code] of wanted) {
      const existing = this.pieceEls.get(square);
      if (existing && existing.code === code) { place(existing.el, square); continue; }
      const reuseIdx = leftovers.findIndex((o) => o.code === code);
      let entry;
      if (reuseIdx >= 0) {
        entry = leftovers.splice(reuseIdx, 1)[0];
      } else {
        const img = document.createElement('img');
        img.src = `pieces/${code[0]}${code[1]}.svg`;
        img.alt = code;
        img.className = 'piece';
        this.pieceLayer.appendChild(img);
        entry = { el: img, code };
      }
      place(entry.el, square);
      this.pieceEls.set(square, entry);
    }
    // 3. anything still orphaned was captured
    for (const o of leftovers) o.el.remove();

    this.overlay.innerHTML = '';
    for (const a of this.arrows) this.drawArrow(a);
  }

  drawArrow({ from, to, kind }) {
    const f = this.coords(from);
    const t = this.coords(to);
    const x1 = f.col + 0.5, y1 = f.row + 0.5;
    const x2 = t.col + 0.5, y2 = t.row + 0.5;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    // shorten so the head lands inside the destination square
    const ux = dx / len, uy = dy / len;
    const ex = x2 - ux * 0.35, ey = y2 - uy * 0.35;

    const ns = 'http://www.w3.org/2000/svg';
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', ex); line.setAttribute('y2', ey);
    line.setAttribute('class', `arrow arrow-${kind}`);
    this.overlay.appendChild(line);

    const head = document.createElementNS(ns, 'polygon');
    const hw = 0.13; // head half-width, kept slim so it never hides a piece
    const hx = x2 - ux * 0.30, hy = y2 - uy * 0.30;
    const px = -uy, py = ux;
    const tipX = x2 - ux * 0.06, tipY = y2 - uy * 0.06;
    head.setAttribute('points', [
      `${tipX},${tipY}`,
      `${hx + px * hw},${hy + py * hw}`,
      `${hx - px * hw},${hy - py * hw}`,
    ].join(' '));
    head.setAttribute('class', `arrowhead arrow-${kind}`);
    this.overlay.appendChild(head);
  }
}
