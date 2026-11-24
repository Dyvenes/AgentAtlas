// Ограниченная очередь событий: дедупликация и порядок по event_id.
//
// Snapshot отвечает «что существует сейчас», события — «что произошло между снимками».
// Поэтому snapshot НЕ стирает ещё не проигранные события: backend шлёт события и сразу за ними
// snapshot, и очистка очереди теряла бы короткие вызовы.

const MAX_SIZE = 500;

export class EventQueue {
  constructor(maxSize = MAX_SIZE) {
    this.maxSize = maxSize;
    this.items = [];
    this.lastId = 0;
    this.droppedCount = 0;
  }

  /**
   * @returns {boolean} true, если событие поставлено в очередь на проигрывание.
   * События с live === false (история: свежепрочитанный журнал) продвигают lastId,
   * но не анимируются.
   */
  push(ev) {
    if (typeof ev?.event_id !== "number") return false;
    if (ev.event_id <= this.lastId) return false;
    this.lastId = ev.event_id;
    if (ev.live === false) return false;
    this.items.push(ev);
    while (this.items.length > this.maxSize) {
      this.items.shift();
      this.droppedCount++;
    }
    return true;
  }

  drain() {
    const out = this.items;
    this.items = [];
    return out;
  }

  /**
   * Вызывается при каждом snapshot. Очередь сохраняется. Исключение — перезапуск сервера:
   * нумерация началась заново (snapshot.last_event_id < lastId), и старые id больше не действуют.
   */
  resetForSnapshot(snapshotEventId) {
    if (typeof snapshotEventId !== "number") return;
    if (snapshotEventId < this.lastId) {
      this.items = [];
      this.lastId = snapshotEventId;
    }
  }
}