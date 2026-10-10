/**
 * Photo mode: a polaroid of the moment (the game picture, a caption, who was there) with a Save button.
 * Opens as an HTML overlay; the game ignores the keyboard while it is open.
 */
export default class PhotoUI {
  /** @param {{onOpen: () => void, onClose: () => void}} hooks */
  constructor({ onOpen, onClose }) {
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.root = document.createElement('div');
    this.root.id = 'photo';
    this.root.hidden = true;
    this.card = document.createElement('div');
    this.card.className = 'polaroid';
    this.img = document.createElement('img');
    this.img.alt = 'Photo';
    this.caption = document.createElement('p');
    this.caption.className = 'caption';
    this.sub = document.createElement('small');
    this.save = document.createElement('a');
    this.save.className = 'btn';
    this.save.textContent = 'Save photo';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.addEventListener('click', () => this.close());
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.append(this.save, close);
    this.card.append(this.img, this.caption, this.sub, bar);
    this.root.append(this.card);
    document.body.append(this.root);
    this.onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        this.close();
      }
    };
  }

  get isOpen() {
    return !this.root.hidden;
  }

  /** @param {{image: string, caption: string, names: string}} photo  `image` is a data URL */
  open({ image, caption, names }) {
    this.img.src = image;
    this.caption.textContent = caption;
    this.sub.textContent = `${names}  -  ${new Date().toLocaleDateString()}`;
    this.save.href = image;
    this.save.download = `fishing-together-${Date.now()}.png`;
    this.root.hidden = false;
    window.addEventListener('keydown', this.onKey);
    this.onOpen();
  }

  close() {
    if (this.root.hidden) return;
    this.root.hidden = true;
    window.removeEventListener('keydown', this.onKey);
    // The same Escape / Enter press must not reach the game (Escape leaves the room): give the game its keyboard back a moment later.
    setTimeout(() => this.onClose(), 200);
  }

  destroy() {
    this.close();
    this.root.remove();
  }
}
