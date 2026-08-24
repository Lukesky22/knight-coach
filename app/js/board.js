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

    this.pieceLayer.innerHTML = '';
    const rows = this.fen.split(' ')[0].split('/');
    for (let r = 0; r < 8; r++) { // r=0 is rank 8
      let file = 0;
      for (const ch of rows[r]) {
        if (/\d/.test(ch)) { file += parseInt(ch, 10); continue; }
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        const type = ch.toUpperCase();
        const rank = 7 - r;
        const disp = this.flip
          ? { row: rank, col: 7 - file }
          : { row: r, col: file };
        const img = document.createElement('img');
        img.src = `pieces/${color}${type}.svg`;
        img.alt = color + type;
        img.className = 'piece';
        img.style.transform = `translate(${disp.col * 100}%, ${disp.row * 100}%)`;
        this.pieceLayer.appendChild(img);
        file++;
      }
    }

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
    const hw = 0.22; // head half-width
    const hx = x2 - ux * 0.42, hy = y2 - uy * 0.42;
    const px = -uy, py = ux;
    const tipX = x2 - ux * 0.08, tipY = y2 - uy * 0.08;
    head.setAttribute('points', [
      `${tipX},${tipY}`,
      `${hx + px * hw},${hy + py * hw}`,
      `${hx - px * hw},${hy - py * hw}`,
    ].join(' '));
    head.setAttribute('class', `arrowhead arrow-${kind}`);
    this.overlay.appendChild(head);
  }
}
