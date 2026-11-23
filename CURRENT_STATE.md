
# Agent Atlas — сводка текущего состояния

Локальная изометрическая визуализация агентов (Codex + OMP) в реальном времени.
Читает `.jsonl`-журналы, строит граф агентов/инструментов/файлов/сайтов/проектов, отображает в браузере.

---

## 1. Стек

**Backend**
- Python 3.12+ (FastAPI, Uvicorn с `uvicorn[standard]` — WebSocket обязателен)
- `asyncio` — поллинг журналов раз в секунду, рассылка снапшота по WS
- Состояние в памяти (`GraphBuilder`), без БД
- `collector.py`, `graph.py`, `app.py`

**Frontend**
- Обычный HTML/CSS/JS (ES-модули), без сборщика
- SVG — вся сцена; Canvas 2D — только пылинки
- SMIL (`<animateMotion>`) — импульсы на рёбрах
- Нативный WebSocket + `fetch`
- `static/index.html`, `app.js`, `layout.js`, `model.js`, `render.js`, `dust.js`

**Тесты**
- `node --test tests/layout.test.js` (6 тестов, все зелёные)

---

## 2. Запуск

```powershell
.\.venv\Scripts\Activate.ps1
pip install "uvicorn[standard]"

# тестовые данные (свежие метки)
python tools/generate_test_logs.py
python app.py --data logs/test_data --window 3600 --stale 300

# реальные логи
python app.py --data "C:\Users\<user>\.codex" --data "C:\Users\<user>\.omp\" --window 3600 --stale 300
```

Флаги: `--window` (сек, окно ресурсов), `--stale` (сек до `stale`), `--idle` (сек `idle→sleeping`), `--host`, `--port`.

URL: `http://127.0.0.1:41735`

---

## 3. Внутренние события (`collector.py → graph.py`)

Шесть `kind`, эмитируемых коллектором:

| kind | источник | поля |
|---|---|---|
| `agent.metadata` | `model`/`modelId`/`modelProvider`, `cwd` | `model, provider, cwd` |
| `agent.parent` | Codex `thread_spawn.parent_thread_id` / OMP `session.parentSession` | `parent_agent_id` |
| `agent.active` | `task_started`, `assistant` (без `endTurn`), `toolResult`, `toolCall`, `tool_execution_start` | `reason` |
| `agent.idle` | `task_complete`, `assistant.stopReason ∈ {endTurn, stop, ...}` | `reason` |
| `agent.error` | `isError: true` в `toolResult`/`tool_result` | — |
| `tool.started` | `toolCall`, `function_call`, `custom_tool_call`, `tool_execution_start` | `tool, call_id, path, url, command` |

Зарезервированы, но **не эмитятся** (нет маркера в логах): `agent.ended`, `agent.spawned`.

`call_id` есть у всех `tool.started`. `tool.completed` **не эмитится** (см. §8).

**Канонический id агента**: `session.id` (OMP) / `session_meta.payload.id` (Codex). Не имя файла.

---

## 4. Модель графа (`graph.py`)

**Узлы** (`node.type`):
- `agent` — сессия; `status ∈ {active, idle, sleeping, error, unknown}`, `stale: bool`, `lifecycle_known: bool`, `parent_agent_id`, `model`, `provider`
- `project` — по `cwd` агента; `project_id` у папок/файлов
- `folder`, `file` — только для write-tools (`write/edit/patch/create/delete/move/rename`); `file.extension`
- `tool` — **глобальный** узел на имя инструмента (`tool:bash`, `tool:read`, …), не per-call
- `site` — `scope ∈ {internet, lan, localhost}` из URL/IP

**Рёбра** (`edge.relation`):
- `uses` — agent → tool
- `writes` — tool → file
- `contains` — project → folder → file
- `requests` — tool → site
- `spawns` — agent → agent (`parent_agent_id`)

**Статусы** (`semantic_status`):
- `active` — последнее событие `agent.active`, `age ≤ stale`
- `stale` — флаг `stale: true`, семантический статус не меняется
- `idle` — `agent.idle`
- `sleeping` — `idle` + `age > --idle`
- `error` — `agent.error`
- `unknown` — нет `lifecycle_known`

**Prune**: через `--window` удаляются не-agent узлы и все рёбра с устаревшим `last_seen`.

---

## 5. Раскладка (`static/layout.js`)

- **Детерминированная**: `mulberry32(hash32(id))`, `Math.random` запрещён
- **Инкрементальная**: если `id ∈ previous` → позиция сохраняется; новый узел — рядом с родителем (`parentOf` через `contains/uses/spawns`)
- **Зоны** (база 1000×1600): sites 150, lan 480, localhost 640, agents 860, projects 1280, folders 1440, files 1560
- **Кластеры**: проекты по сетке `cols ≤ 4`, `cellW=300`, `cellH=500`; агенты — над своим проектом
- **Агенты без проекта**: полоса по 10 в ряд сверху
- **`fitCamera`**: на fixture 200 узлов `zoom ≥ 0.7` при 1080×1920

---

## 6. Рендер (`static/render.js`)

**Слои** (снизу вверх): `islands → clouds → edges → impulses → nodes`

- **Islands**: `crystal_floating_platform.webp` / `neon_crystal_platform.webp`, размер ∝ `memberCount(project)`, выбор по `hash32(project.id) % 2`
- **Clouds**: три типа (internet/LAN/localhost), только если есть соответствующие сайты
- **Edges**: cubic Bézier, `active` класс + glow; импульсы 3×/1.8s на активных
- **Nodes**: спрайты по типу, дрейф (`--amp 3..6px`, `--dur 5..9s`, seeded), порядковый номер `#N` у одинаковых провайдеров
- **Orbit**: свёрнутые потомки → шарики на орбите, `_tickOrbits` через RAF (60 FPS)
- **Frontend caps**: `MAX_FILES=400`, `MAX_FOLDERS=200`, `MAX_EDGES=2500`

**Состояния (CSS)**:
- `active` — пульсация aura
- `idle` — дыхание
- `sleeping` — `opacity 0.15`, `z z z`
- `error` — красная aura + `!` + shake (1×)
- `ended` — `opacity 0.35` + `✓`
- `stale` — серый `?` + tooltip «нет свежих данных»

---

## 7. Сворачивание (`C1–C4`)

**Разведка (C1)** подтвердила достоверные поля:
- Codex: `session_meta.payload.source.subagent.thread_spawn.parent_thread_id`
- OMP: `session.parentSession` (путь) → id родителя из первой `type:"session"` строки

**Логика**:
- `isCollapsed(child)` = `parent in scene && status ∈ {idle, sleeping, ended} && lifecycle_known && !expandedSet.has(child.id)`
- `error/active/stale` — не сворачиваются
- **Орбита**: радиус `parent.r + 22`, до 6 спутников, `_tickOrbits` через RAF
- **Клик по спутнику** → `expandedSet.add(child)` → `_rebuild` → ребёнок развёрнут
- **`expandedSet` в `topologyKey`** → клик гарантированно триггерит `_rebuild`
- **Рёбра** `spawns` к свёрнутым — `spawns-collapsed` (пунктир), перепривязка к `orbitFor`
- **Карточка родителя**: «Дочерние агенты: N (M активных)»

**Тестовые данные**: `agent:01-test-parent → agent:01-test-child`, работает end-to-end.

---

## 8. Реальность журналов (сводка по 189 файлам)

| Поле / событие | OMP | Codex |
|---|---|---|
| Файлов прочитано | 134 | 55 |
| `thinking` / `reasoning` | 7301 | 675 |
| `toolCall` / `tool_result` пары | 10 856 / 10 850 (6 без пары) | 681 / 681 |
| `parentSession` / `thread_spawn.parent_thread_id` | 96 файлов / 43 `task` | 2 |
| `stopReason == "error"` | 124 | — |
| `turn_aborted` | — | 2 |

**Ограничения:**
- `Thinking` vs `Waiting` — **не различить** как текущую фазу (reasoning-блоки — это завершённые рассуждения, не «думает сейчас»)
- `tool.completed` — **не эмитится** (есть в данных: `toolResult.toolCallId`, `*_output.call_id`)
- `agent.ended` — **недостижим** (нет `sessionEnd`/closed-маркера); `idle → sleeping` = «давно неактивен», не «завершён»
- `Delegating` — определяется только по `parent_thread_id`/`parentSession`, не по времени/cwd/имени инструмента

---

## 9. Что работает (приёмка плана)

- ✅ Изометрия 1000×1600, портрет 1080×1920
- ✅ Кластеры по проектам (`cwd`), инкрементальная раскладка
- ✅ `fitCamera.zoom ≥ 0.7` на 200 узлах
- ✅ Облака (internet/LAN/localhost), острова под кластерами
- ✅ Дрейф 3–6 ед., 5–9 s, hash-seeded
- ✅ Ручной zoom/pan + fit, поиск с подсветкой
- ✅ Карточка у узла + drawer с close/deselect
- ✅ Порядковый номер `#N` у одинаковых провайдеров
- ✅ Импульсы на активных рёбрах (3×/1.8s)
- ✅ Пылинки ≤ 64 (Canvas, предрастерённые спрайты)
- ✅ `prefers-reduced-motion`, пауза на hidden (SVG + dust + orbit)
- ✅ `spawns`/сворачивание/орбита/раскрытие кликом
- ✅ `tool.started` для всех вызовов

## 10. Что не сделано

| Пункт | Причина | Усилие |
|---|---|---|
| `tool.completed` | Не эмитится; данные есть (99.94% OMP, 100% Codex) | ~30 мин |
| `agent.error` по `stopReason == "error"` | Сейчас `stopReason == "error"` → `idle` | ~15 мин |
| `turn_aborted` (Codex) | Не эмитится | ~10 мин |
| `agent.ended` | Нет маркера в логах | требует данных |
| Реальные SVG-логотипы | Сейчас 2-буквенный шильдик (`OP`, `AN`, `GO`) | нужны ассеты |
| `+N` бейдж >6 свёрнутых | Код скрывает сверх 6, бейдж не рисуется | ~15 мин |
| Тул-дуга per-agent | Safety-cap сделал tools глобальными | потребует пересмотра |
| SSE | Используется WebSocket, SSE не нужен | — |

---

## 11. Файловая структура

```
AgentAtlas/
├── app.py                    # FastAPI + WS + lifespan
├── collector.py              # JSONL → внутренние события
├── graph.py                  # события → узлы/рёбра → snapshot
├── package.json              # node --test
├── logs/
│   ├── codex-rollout.jsonl   # реальный сэмпл
│   ├── omp.jsonl             # реальный сэмпл
│   └── test_data/            # сгенерированные тесты
├── static/
│   ├── index.html            # оболочка + CSS
│   ├── app.js                # WS, камера, поиск, карточка, drawer
│   ├── layout.js             # детерминированная раскладка
│   ├── model.js              # isCollapsed, orbitPosition, childrenMap
│   ├── render.js             # SVG-сцена + SceneRenderer
│   ├── dust.js               # Canvas-пылинки
│   └── sprites/              # webp + png ассеты
├── tests/
│   └── layout.test.js        # 6 тестов
├── tools/
│   └── generate_test_logs.py # свежие .jsonl
└── atlas-visual-plan*.md     # план
```

---

## 12. Быстрая проверка

```powershell
# тесты
node --test tests/layout.test.js         # 6/6

# backend
Invoke-RestMethod http://127.0.0.1:41735/api/graph |
  Select-Object -ExpandProperty nodes | Group-Object type | Format-Table

# spawns
$r = Invoke-RestMethod http://127.0.0.1:41735/api/graph
$r.edges | Where-Object { $_.relation -eq "spawns" } | Format-Table source, target
$r.nodes | Where-Object { $_.type -eq "agent" -and $_.parent_agent_id } |
  Select-Object id, parent_agent_id, status

# frontend (в DevTools Console)
document.querySelectorAll(".node").length
document.querySelectorAll(".orbit-satellite").length
document.querySelectorAll(".edge.spawns").length
```

---

## 13. Что дальше (приоритет)

1. **`tool.completed` + `agent.error` по `stopReason == "error"`** — одно расширение `collector.py` + `graph.py`; оба достоверны
2. **Проверка на реальных логах** — 96 OMP + 2 Codex дадут реальные `spawns`-цепочки
3. **`+N` бейдж** — UX-мелочь
4. **Реальные логотипы** — если пришлёте SVG
5. **`agent.ended`** — только если найдётся маркер (`sessionEnd`/`closed`)
```

Сохраните как `PROJECT_STATE.md` в корне проекта. Это фиксирует текущее состояние и приоритеты для продолжения работы — как с вами, так и с небольшой локальной моделью.