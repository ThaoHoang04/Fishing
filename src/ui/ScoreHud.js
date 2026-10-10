import { SLOT_COLORS } from '../entities/NameTag.js';

/** Session scoreboard: one line per player under the controls hint. Fish caught, rare+ catches, biggest fish. */
export default class ScoreHud {
  constructor(scene) {
    this.scene = scene;
    this.lines = [0, 1].map((i) =>
      scene.add
        .text(4, 44 + i * 15, '', { fontFamily: 'monospace', fontSize: '8px', color: SLOT_COLORS[i], stroke: '#000000', strokeThickness: 2, backgroundColor: '#000000bb', padding: { x: 3, y: 1 } })
        .setResolution(4)
        .setScrollFactor(0)
        .setDepth(9990));
  }

  /** Move the board so it sits under the controls text (which grows a line on some maps). */
  setTop(y) {
    this.lines.forEach((l, i) => l.setY(Math.round(y + i * 15)));
  }

  /** @param {{name: string, slot: number, stats: {caught: number, biggest: number, rare: number}}[]} players */
  update(players) {
    this.lines.forEach((line, i) => {
      const p = players.find((q) => q.slot === i);
      if (!p) return line.setText('');
      const s = p.stats ?? { caught: 0, biggest: 0, rare: 0 };
      line.setText(`${p.name}  fish ${s.caught}  rare ${s.rare}  best ${s.biggest > 0 ? `${s.biggest.toFixed(2)}kg` : '-'}`);
    });
  }

  destroy() {
    this.lines.forEach((l) => l.destroy());
  }
}

/** The numbers for one catch, merged into a player's session stats (used by the offline mode; the server does it online). */
export function addToStats(stats, { weight, rarity }, isRareOrBetter) {
  stats.caught++;
  stats.biggest = Math.max(stats.biggest, weight);
  if (isRareOrBetter(rarity)) stats.rare++;
  return stats;
}
