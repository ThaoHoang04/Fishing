import { TEXTURES } from '../constants/assetKeys.js';

const CHEST_FRAME = 10; // the mossy chest in the fish icon sheet

/**
 * Drawing for the random events: the seagull after your fish, the treasure chest on the ground, and the glowing lucky spot.
 * It only draws and remembers what the server announced; the server decides everything.
 */
export default class RandomFx {
  constructor(scene) {
    this.scene = scene;
    this.g = scene.add.graphics().setDepth(9000);
    this.gull = null; // {start, readyMs, windowMs, anchor}
    this.chest = null; // {id, mapId, x, y, range, until, sprite, label}
    this.boss = null; // {spotId, name, until}: the boss's spot (red ring)
    this.bossBanner = scene.add
      .text(240, 76, '', { fontFamily: 'sans-serif', fontSize: '12px', fontStyle: 'bold', color: '#ff6b6b', stroke: '#000000', strokeThickness: 4, align: 'center', backgroundColor: '#000000cc', padding: { x: 8, y: 4 } })
      .setOrigin(0.5, 0).setResolution(4).setScrollFactor(0).setDepth(10006).setVisible(false);
    this.bossUntil = 0;
    this.rush = null; // {spotId, name, until, claimedBy, spot}: a rare fish is splashing at a spot
    // right-hand column: the contest and the little toasts for titles and levels
    const right = (y, size, color) => scene.add
      .text(472, y, '', { fontFamily: 'sans-serif', fontSize: size, fontStyle: 'bold', color, stroke: '#000000', strokeThickness: 3, align: 'right' })
      .setOrigin(1, 0).setResolution(4).setScrollFactor(0).setDepth(9991).setVisible(false);
    this.contestHead = right(78, '8px', '#9fe3ff');
    this.contestScores = right(89, '8px', '#ffffff');
    this.toastLine = right(112, '9px', '#ffe14d');
    this.toastUntil = 0;
    this.contest = null; // {kind, name, unit, until, scores}
    this.duel = null; // {a, b, hp, max, startAt, endsAt}: a duel is on
    this.duelOffer = null; // {from, until}: someone challenged us
    this.duelText = scene.add
      .text(240, 232, '', { fontFamily: 'sans-serif', fontSize: '8px', fontStyle: 'bold', color: '#ffffff', stroke: '#000000', strokeThickness: 3, align: 'center' })
      .setOrigin(0.5, 1).setResolution(4).setScrollFactor(0).setDepth(10005).setVisible(false);
    this.luckyLabel = scene.add
      .text(472, 64, '', { fontFamily: 'sans-serif', fontSize: '8px', fontStyle: 'bold', color: '#ffd166', stroke: '#000000', strokeThickness: 3 })
      .setOrigin(1, 0).setResolution(4).setScrollFactor(0).setDepth(9991).setVisible(false);
  }

  // ---- seagull ----

  gullAttack(anchor, { readyMs, windowMs }) {
    this.gull = { start: this.scene.time.now, readyMs, windowMs, anchor };
    this.scene.sfx?.play('gull');
  }

  gullDone() {
    this.gull = null;
  }

  // ---- chest ----

  chestSpawn({ id, mapId, x, y, lifeMs, range }) {
    this.chestGone();
    if (mapId !== this.scene.map.id) return; // it is on the other map: nothing to draw here
    const sprite = this.scene.add.image(Math.round(x), Math.round(y), TEXTURES.FISH_ICONS, CHEST_FRAME).setOrigin(0.5, 1).setScale(2).setDepth(y);
    const label = this.scene.add
      .text(Math.round(x), Math.round(y) - 36, 'Treasure! Both press O', { fontFamily: 'sans-serif', fontSize: '7px', fontStyle: 'bold', color: '#ffd166', stroke: '#000000', strokeThickness: 3 })
      .setOrigin(0.5, 1).setResolution(4).setDepth(9000);
    this.chest = { id, mapId, x, y, range, until: this.scene.time.now + lifeMs, sprite, label };
    this.scene.sfx?.play('rare');
  }

  chestGone(id) {
    if (!this.chest || (id !== undefined && this.chest.id !== id)) return;
    this.chest.sprite.destroy();
    this.chest.label.destroy();
    this.chest = null;
  }

  chestOpened(id, anchors, each) {
    for (const a of anchors) if (a) this.scene.combatFx.pop(a, `+${each} coins`, '#ffd166');
    this.chestGone(id);
  }

  chestNear(player, mapId) {
    const c = this.chest;
    return Boolean(c) && c.mapId === mapId && Math.hypot(player.x - c.x, player.y - c.y) <= c.range;
  }

  // ---- titles and levels ----

  /** A small message in the right-hand column for a few seconds ("TITLE UNLOCKED: Fish Thief"). */
  toast(text, color = '#ffe14d') {
    this.toastLine.setText(text).setColor(color).setVisible(true);
    this.toastUntil = this.scene.time.now + 4500;
    this.scene.sfx?.play('rare');
  }

  // ---- duels ----

  offered(e, now) {
    this.duelOffer = { from: e.from, until: now + e.ms };
    this.scene.sfx?.play('duel');
  }

  duelStart(e, now) {
    this.duelOffer = null;
    this.duel = { a: e.a, b: e.b, hp: { [e.a]: e.hp, [e.b]: e.hp }, max: e.hp, startAt: now + e.countdownMs, endsAt: now + e.countdownMs + e.durationMs };
    this.scene.sfx?.play('duel');
  }

  duelHp(hp) {
    if (this.duel && hp) this.duel.hp = hp;
  }

  duelEnd(r, nameOf) {
    this.duel = null;
    this.duelOffer = null;
    const verdict = r.reason === 'cancelled' ? 'Duel called off' : r.winner ? `${nameOf(r.winner)} wins the duel!${r.coins ? ` +${r.coins} coins` : ''}` : 'The duel is a draw';
    this.bossBanner.setColor('#ffe14d').setText(`DUEL OVER\n${verdict}`).setVisible(true);
    this.bossUntil = this.scene.time.now + 5000;
    this.scene.sfx?.play(r.winner ? 'record' : 'rare');
  }

  /** The prompt when someone challenges us ("Y: accept / N: decline"), or ''. */
  duelHint(nameOf, now) {
    const o = this.duelOffer;
    if (!o || now > o.until) return '';
    return `${nameOf(o.from)} challenges you to a DUEL!  Y: accept   N: decline`;
  }

  // ---- the mini contest ----

  contestStart(e, now) {
    this.contest = { kind: e.kind, name: e.name, unit: e.unit, until: now + e.durationMs, scores: e.scores ?? {} };
    this.scene.sfx?.play('horn');
  }

  contestScore(scores) {
    if (this.contest) this.contest.scores = scores;
  }

  /** From the room state: a contest that started before we joined, or already ended. */
  contestSync(room, now) {
    const c = room?.challenge;
    if (!c) {
      if (this.contest && this.contest.until < now - 2000) this.contest = null;
      return;
    }
    const until = now + c.remainingMs - (performance.now() - room.receivedAt);
    // The live scores come from the score events; the room snapshot is only for a contest we have not heard about yet.
    this.contest = this.contest ?? { kind: c.kind, name: c.name, unit: c.unit, until, scores: c.scores };
  }

  /** The contest is over: show the result for a while. `nameOf(pid)` turns a player id into a name. */
  contestEnd(r, nameOf) {
    this.contest = null;
    const scoreText = (pid) => `${nameOf(pid)} ${r.unit === 'kg' ? `${(r.scores[pid] ?? 0).toFixed(1)} kg` : r.unit === 's' ? ((r.scores[pid] ?? 0) > 0 ? `${r.scores[pid].toFixed(1)} s` : '-') : r.scores[pid] ?? 0}`;
    const line = Object.keys(r.scores).map(scoreText).join('   vs   ');
    const verdict = r.cancelled ? 'Contest called off' : r.winner ? `${nameOf(r.winner)} wins!` : "It's a tie!";
    this.bossBanner.setColor('#ffe14d').setText(`${r.name.toUpperCase()}\n${line}\n${verdict}`).setVisible(true);
    this.bossUntil = this.scene.time.now + 7000;
    this.scene.sfx?.play(r.winner ? 'record' : 'rare');
  }

  // ---- the co-op boss ----

  /** BOSS FISH SPOTTED! (or, with null, it is gone). Shows a banner for a few seconds and plays the alarm. */
  bossAnnounce(e) {
    if (!e || e.caught !== undefined) {
      this.bossBanner.setVisible(false);
      return;
    }
    const where = e.spotId.replace(/_/g, ' ');
    this.bossBanner.setColor(e.giant ? '#ffb86b' : '#ff6b6b').setText(e.giant ? `GIANT FISH SPOTTED!
${e.name} at ${where}.
Too heavy for one: both cast there and haul it together!` : `BOSS FISH SPOTTED!
${e.name} at ${where}.
Both cast there and hook it together!`).setVisible(true);
    this.bossUntil = this.scene.time.now + 7000;
    this.scene.sfx?.play('boss');
  }

  /** Fish Rush: a rare fish splashes at a spot for a few seconds; the first cast there gets it. */
  rushAnnounce(e) {
    const where = e.spotId.replace(/_/g, ' ');
    this.bossBanner.setColor('#ffd166').setText(`RARE SPLASH!
${e.name} at ${where}.
First to CAST there gets it!`).setVisible(true);
    this.bossUntil = this.scene.time.now + 5000;
    this.scene.sfx?.play('rare');
  }

  rushClaimed(e, nameOf) {
    this.bossBanner.setColor('#ffd166').setText(`${nameOf(e.by)} was first to the ${e.name}!`).setVisible(true);
    this.bossUntil = this.scene.time.now + 3500;
  }

  rushState(state, spots) {
    this.rush = state ? { ...state, spot: spots.find((s) => s.id === state.spotId) ?? null } : null;
  }

  /** The boss spot from the room state (null when there is none): a red ring and a label at that spot. */
  bossSpot(state, spots) {
    this.boss = state ? { ...state, spot: spots.find((s) => s.id === state.spotId) ?? null } : null;
  }

  // ---- lucky spot ----

  /** @param {{spotId: string, until: number} | null} state  @param {{id: string, x: number, y: number}[]} spots */
  lucky(state, spots, now, worldNow) {
    this.luckySpot = state ? spots.find((s) => s.id === state.spotId) ?? null : null;
    this.luckyState = state;
    if (this.luckySpot && state) {
      const secs = Math.max(0, Math.ceil((state.until - worldNow) / 1000));
      this.luckyLabel.setVisible(true).setText(`Lucky spot: ${state.spotId.replace(/_/g, ' ')} (${secs}s)`);
    } else this.luckyLabel.setVisible(false);
  }

  // ---- per frame ----

  /** What the controls line should say about a seagull or a chest (or ''). */
  hint(player, mapId, now) {
    if (this.gull) return now - this.gull.start < this.gull.readyMs ? 'A seagull circles your fish...' : (Math.floor(now / 160) % 2 ? 'C: SHOO THE SEAGULL!' : 'C: shoo it!');
    if (this.chestNear(player, mapId)) return 'O: Open the chest (your friend must press O too)';
    return '';
  }

  update(player, nameOf = (pid) => pid) {
    const now = this.scene.time.now;
    const g = this.g.clear();
    if (this.toastLine.visible && now > this.toastUntil) this.toastLine.setVisible(false);
    if (this.duel) {
      const d = this.duel;
      const bar = (pid, x, color) => {
        const w = 80;
        const left = x;
        g.fillStyle(0x000000, 0.8).fillRect(left - 1, 236, w + 2, 8);
        g.fillStyle(color, 1).fillRect(left, 237, Math.round((w * Math.max(0, d.hp[pid] ?? 0)) / d.max), 6);
      };
      bar(d.a, 80, 0x7fd1ff);
      bar(d.b, 320, 0xffb86b);
      const wait = Math.ceil((d.startAt - now) / 1000);
      this.duelText.setVisible(true).setText(now < d.startAt ? (wait > 0 ? `DUEL!  ${wait}` : 'FIGHT!') : `${nameOf(d.a)} ${Math.round(d.hp[d.a] ?? 0)}      ${nameOf(d.b)} ${Math.round(d.hp[d.b] ?? 0)}`);
      if (now > d.endsAt + 2000) this.duel = null;
    } else this.duelText.setVisible(false);
    if (this.contest) {
      const left = Math.max(0, Math.ceil((this.contest.until - now) / 1000));
      this.contestHead.setVisible(true).setText(`CONTEST: ${this.contest.name}  ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);
      const unit = this.contest.unit;
      this.contestScores.setVisible(true).setText(Object.entries(this.contest.scores).map(([pid, v]) => `${nameOf(pid)} ${unit === 'kg' ? `${v.toFixed(1)}kg` : unit === 's' ? (v > 0 ? `${v.toFixed(1)}s` : '-') : v}`).join('   '));
    } else {
      this.contestHead.setVisible(false);
      this.contestScores.setVisible(false);
    }
    if (this.luckySpot) {
      const pulse = Math.sin(now / 250) * 0.5 + 0.5;
      const { x, y } = this.luckySpot;
      g.fillStyle(0xffd166, 0.18 + pulse * 0.12).fillEllipse(x, y, 40 + pulse * 6, 20 + pulse * 3);
      g.lineStyle(2, 0xffe9a6, 0.7 + pulse * 0.3).strokeEllipse(x, y, 40 + pulse * 6, 20 + pulse * 3);
      for (let i = 0; i < 4; i++) {
        const a = now / 400 + (i * Math.PI) / 2;
        g.fillStyle(0xffffff, 0.9).fillRect(Math.round(x + Math.cos(a) * 16), Math.round(y - 4 + Math.sin(a) * 6), 2, 2);
      }
    }
    if (this.bossBanner.visible && now > this.bossUntil) this.bossBanner.setVisible(false);
    if (this.boss?.spot && now < this.boss.until) {
      const { x, y } = this.boss.spot;
      const pulse = Math.sin(now / 160) * 0.5 + 0.5;
      g.fillStyle(0xff3b3b, 0.16 + pulse * 0.14).fillEllipse(x, y, 54 + pulse * 10, 28 + pulse * 5);
      g.lineStyle(2, 0xff6b6b, 0.7 + pulse * 0.3).strokeEllipse(x, y, 54 + pulse * 10, 28 + pulse * 5);
      if (!this.bossLabel) {
        this.bossLabel = this.scene.add.text(x, y - 26, '', { fontFamily: 'sans-serif', fontSize: '8px', fontStyle: 'bold', color: '#ff8a8a', stroke: '#000000', strokeThickness: 3 }).setOrigin(0.5, 1).setResolution(4).setDepth(9000);
      }
      this.bossLabel.setPosition(x, y - 26).setText(`${this.boss.giant ? 'GIANT' : 'BOSS'}: ${this.boss.name}`).setVisible(true);
    } else this.bossLabel?.setVisible(false);
    if (this.rush?.spot && !this.rush.claimedBy && now < this.rush.until) {
      const { x, y } = this.rush.spot;
      const pulse = Math.sin(now / 110) * 0.5 + 0.5;
      g.fillStyle(0xffd166, 0.18 + pulse * 0.16).fillEllipse(x, y, 46 + pulse * 12, 24 + pulse * 6);
      g.lineStyle(2, 0xffe9a8, 0.7 + pulse * 0.3).strokeEllipse(x, y, 46 + pulse * 12, 24 + pulse * 6);
      if (!this.rushLabel) {
        this.rushLabel = this.scene.add.text(x, y - 26, '', { fontFamily: 'sans-serif', fontSize: '8px', fontStyle: 'bold', color: '#ffe9a8', stroke: '#000000', strokeThickness: 3 }).setOrigin(0.5, 1).setResolution(4).setDepth(9000);
      }
      this.rushLabel.setPosition(x, y - 26).setText(`${this.rush.name}! ${Math.max(0, Math.ceil((this.rush.until - now) / 1000))}s`).setVisible(true);
    } else this.rushLabel?.setVisible(false);
    if (this.chest) {
      if (now > this.chest.until) return this.chestGone();
      this.chest.sprite.setY(Math.round(this.chest.y) + Math.round(Math.sin(now / 300)));
    }
    if (this.gull && player.sprite?.active) this.drawGull(g, now, player);
  }

  drawGull(g, now, player) {
    const { start, readyMs, windowMs } = this.gull;
    const t = now - start;
    const swoop = t < readyMs ? 0 : Math.min(1, (t - readyMs) / Math.max(1, windowMs - readyMs));
    const a = t / 260;
    const r = 26 * (1 - swoop * 0.8);
    const x = player.sprite.x + Math.cos(a) * r;
    const y = player.sprite.y - 30 + swoop * 20 + Math.sin(a) * r * 0.4;
    const flap = Math.sin(t / 70) * 3;
    g.lineStyle(2, 0xffffff, 1).beginPath().moveTo(x - 6, y + flap).lineTo(x, y - 2).lineTo(x + 6, y + flap).strokePath();
    g.fillStyle(0xffffff, 1).fillRect(Math.round(x) - 1, Math.round(y) - 2, 3, 3);
    g.fillStyle(0xffb347, 1).fillRect(Math.round(x) + 2, Math.round(y) - 1, 2, 1);
  }

  destroy() {
    this.g.destroy();
    this.chestGone();
    this.luckyLabel.destroy();
    this.bossBanner.destroy();
    for (const o of [this.contestHead, this.contestScores, this.toastLine, this.duelText]) o.destroy();
    this.bossLabel?.destroy();
    this.rushLabel?.destroy();
  }
}
