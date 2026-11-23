# Agent Atlas — разбиение разработки на пакеты для нескольких ИИ

## 1. Как пользоваться
Каждому исполнителю отправьте **четыре вещи**:
1. `atlas-visual-plan.md` — основной план (шаги 1–15).
2. `atlas-visual-plan-addendum.md` — дополнение; **оно приоритетнее** основного плана.
3. Этот файл.
4. Одну строку: «Твой пакет — WP-X».

Исполнитель читает разделы 3–4 этого файла (правила и контракты) и **только свой** пакет из раздела 5, плюс разделы плана/дополнения, на которые пакет ссылается. Остальные пакеты читать не нужно.

Шаблон сообщения — в разделе 8.

## 2. Порядок (волны)
| Волна | Пакеты | Кто |
|---|---|---|
| 0 | **WP0** контракты и каркас | самая сильная модель, одна, первой |
| 1 (параллельно) | **WP-A** адаптеры, **WP-B** snapshot и граф, **WP-C** модель и раскладка, **WP-D** геометрия/движение/ввод, **WP-F** арты и атлас | A+B можно одной моделью, C+D одной |
| 2 | **WP-E** renderer (Pixi) | сильная модель |
| 3 | **WP-G** оболочка (GraphView, App) | можно начать раньше на заглушке renderer из WP0 |
| 4 | **WP-H** приёмка, замеры, EXE | сильная модель или вы |

Слияние строго по готовности пакета и по порядку: WP0 → A → B → C → D → F → E → G → H. После каждого слияния интегратор запускает проверки раздела 7.

## 3. Правила для всех исполнителей
1. Работать в своей ветке `wp-<имя>` и отдельном `git worktree`. Никогда не работать в общей рабочей папке параллельно с другими.
2. **Править только файлы своего пакета.** Файлы других пакетов, `types.ts`, `package.json`, `package-lock.json` не трогать (их владелец — WP0/интегратор).
3. Нужно изменить контракт (раздел 4)? Не править самому: записать запрос в `CONTRACT_CHANGES.md` (что, зачем, какой пакет затронут) и продолжать на текущем контракте.
4. Корень проекта `D:/PythonProjects/orca/projects/my_things`, ОС Windows, PowerShell. Не запускать одновременно сервер исходников и EXE на 41735. Не чистить Temp; не трогать чужие процессы.
5. Ничего не выдумывать: не угадывать логотипы, родителя агента, файловость пути, активность. Нет данных — `null`/unknown/робот.
6. Никаких `Math.random` в раскладке (только seeded rng), никаких CDN в runtime, никаких текстов prompt/ответов в событиях.
7. Если шаг или проверка не проходит — исправлять текущий шаг, не переходить дальше.
8. Перед кодом **прочитать реальные исходники затрагиваемых файлов**: якоря плана могли устареть.
9. Сдавая пакет, вернуть отчёт: список изменённых файлов, вывод команд проверок, открытые вопросы, отклонения от плана.

## 4. Контракты (заморожены WP0; изменение только через CONTRACT_CHANGES.md)
Имена типов `GraphNode`, `GraphEdge`, `Snapshot`, `ViewMode` — из существующего `frontend/src/types.ts`. WP0 сверяет имена с реальным кодом и исправляет этот раздел.

**C1. Payload событий (backend, пакеты A и B)**
- `agent.metadata`: `{model_id: string|null, model_provider: string|null, cwd: string|null, parent_agent_id: string|null}` — всегда полный набор.
- `agent.active|idle|error|ended`: `{cwd?: string}`, без текстов.
- `agent.telemetry`: `{cwd?: string}`.
- `tool.started`: прежний payload + `path_resources: [{path: string, path_kind: "file"|"directory"|"unknown"}]` (поле `paths` сохраняется).
- `parent_agent_id` — id агента-родителя в том же формате, что `agent_id` событий. Ссылка может указывать на агента, которого нет в snapshot.

**C2. Snapshot (пакет B → клиент)**
- `EntityKind` + `"file"`; `GraphNode.data` — поля из раздела «Контракты новых данных» плана + `parent_agent_id?: string | null`.
- Новые виды рёбер: `"contains"` (папка→файл), `"spawns"` (родитель→потомок), `"accesses"` (агент→файл).

**C3. Типы сцены (`frontend/src/scene/types.ts`, шаг 2 плана) + добавки**
- `SceneNode` + `collapsedInto?: string` (id верхнего агента, к которому свёрнут) и `childCount?: number` (всего потомков, на родителе).
- `SceneOptions` + `expanded: ReadonlySet<string>` (родители с раскрытой группой).
- `RendererCallbacks` + `onToggleGroup: (parentId: string) => void`.
- `SceneModel.nodes` содержит видимые узлы **и свёрнутых потомков** (с `collapsedInto` и позицией на орбите), чтобы работал `hitTest`; renderer рисует до 6 спутников на родителя, остальные учитываются в бейдже «+N».

**C4. Функции**
- `resolveIcon(node: GraphNode): string` → ключи `provider:<имя>` или `object:robot|folder|file|project|tool|domain`.
- `buildSceneModel(snapshot, options, previous): SceneModel` (шаг 8).
- `layoutScene(input: LayoutInput): Map<string, Point>`, где `LayoutInput = { nodes: GraphNode[]; edges: {source: string; target: string; kind: string}[]; previous: ReadonlyMap<string, Point>; pinned: ReadonlyMap<string, Point> }`. Работает по **полному** snapshot, без учёта фильтров.
- `computeCollapse(nodes: GraphNode[], expanded: ReadonlySet<string>): Map<string, string>` — свёрнутый потомок → id верхнего видимого предка.
- Геометрия, движение, ввод, `SceneRenderer` — сигнатуры из шагов 9, 10, 11 плана.

**C5. Ключи спрайтов (`atlas.json` и `resolveIcon`)**
Формат `frontend/public/scene/atlas/atlas.json`:
```
{"version":1,"atlases":{"objects":"objects.webp","fx":"fx.webp"},
 "sprites":{"<ключ>":{"atlas":"objects|fx","x":0,"y":0,"w":0,"h":0,"anchorX":0.5,"anchorY":0.85}}}
```
Ключи: `object:medallion`, `object:robot`, `object:project`, `object:folder`, `object:file`, `object:tool`, `object:domain`, `object:island:1..3`, `fx:cloud_internet:1..3`, `fx:cloud_lan`, `fx:cloud_localhost`, `fx:ring_active`, `fx:haze:1..2`. Логотипы провайдеров (`provider:*`) в атлас **не входят**: это отдельные SVG, их загружает `assets.ts`.

Соответствие сырых файлов из `atlas-sprite-prompts.md` ключам: `agent_medallion`→`object:medallion`, `robot_agent`→`object:robot`, `project_stack`→`object:project`, `folder`→`object:folder`, `file`→`object:file`, `tool_module`→`object:tool`, `site_globe`→`object:domain`, `island__N`→`object:island:N`, `cloud_internet__N`→`fx:cloud_internet:N`, `cloud_lan`, `cloud_localhost`, `ring_active`, `haze__N` — в `fx:` с тем же именем.

## 5. Пакеты

### WP0. Контракты и каркас (первым, в `main`)
- **Цель:** дать остальным общий фундамент, чтобы пакеты не конфликтовали.
- **Файлы (владелец):** `frontend/src/types.ts`, `frontend/src/scene/types.ts`, `frontend/package.json` и lockfile, `frontend/vitest.config.ts`, `frontend/playwright.config.ts`, `CONTRACTS.md` (раздел 4 этого файла, сверенный с кодом), заглушки: `scene/{model,layout,collapse,rng,geometry,motion,input,renderer,paint,assets}.ts` с экспортами и сигнатурами из раздела 4 (тела: `throw new Error("not implemented")`; `SceneRenderer` — заглушка, компилируется).
- **Шаги плана:** 1 (инструменты проверки) + 2 (типы) + добавки из раздела 4. В step 1 добавить также `pixi.js` (дополнение, раздел A) и Pillow в dev-зависимости Python для `tools/sprites`.
- **Проверка:** `npm run build` из `frontend/` проходит; `npm run test:unit` запускается (без тестов допустимо, `passWithNoTests`); `python -m pytest -q` не хуже, чем до пакета.
- **Готовность:** в `main` лежат типы, заглушки, зависимости; раздел 4 соответствует реальному коду.

### WP-A. Адаптеры и разведка логов
- **Файлы:** `agent_atlas/adapters/*`, `agent_atlas/identity.py`, `tests/test_adapters.py`, `docs/parent-child-discovery.md`.
- **Не трогать:** `graph.py`, `database.py`, `collector.py`, frontend.
- **Шаги:** сначала **разведка C1 (дополнение, раздел C1)** — read-only разбор реальных JSONL OMP/Codex, отчёт `docs/parent-child-discovery.md` только с именами полей и структурой, без текстов; затем шаг 3 плана (lifecycle и `model_provider`, таблица «Телеметрия») и шаг 4 (`extract_path_resources`, `path_resources`). `parent_agent_id` писать в `agent.metadata` **только если разведка нашла достоверное поле**, иначе `null`.
- **Проверка:** `python -m pytest tests/test_adapters.py -q`.
- **Готовность:** последовательность prompt→tool→toolResult→final даёт active до final и idle после; нет угаданного провайдера и файла; payload соответствует C1.

### WP-B. Snapshot, коллектор, граф
- **Файлы:** `agent_atlas/database.py`, `collector.py`, `graph.py`, `network.py`, `api.py` (только строка snapshot), `tests/test_database.py`, `tests/test_collector.py`, `tests/test_graph.py`, `tests/test_network.py`.
- **Не трогать:** адаптеры, frontend.
- **Шаги:** 5 и 6 плана + C2/C3 дополнения: чтение `parent_agent_id` из `agent.metadata`, `data.parent_agent_id`, рёбра `spawns` (parent→child, активны пока потомок `active`), защита от циклов и отсутствующего родителя. Работает на **синтетических событиях** по C1, не дожидаясь пакета A.
- **Проверка:** `python -m pytest tests/test_graph.py tests/test_database.py tests/test_collector.py tests/test_network.py tests/test_api.py -q`.
- **Готовность:** состояния sleeping/stale строго по формулам плана; heartbeat snapshot в тишине; file/folder различны; `spawns` корректны.

### WP-C. Модель сцены и раскладка
- **Файлы:** `frontend/src/scene/{model,layout,collapse,rng}.ts` и `*.test.ts`, `frontend/tests/fixtures/scene.ts`.
- **Не трогать:** Pixi, `renderer.ts`, геометрию, App.
- **Шаги:** шаг 8 плана; **дополнение, разделы B и C4** (кластерная раскладка, сворачивание); fixture из шага 14 с родителями/потомками (раздел E дополнения), `makeStateFixture`.
- **Проверка:** `npm run test:unit -- src/scene/model.test.ts src/scene/layout.test.ts src/scene/collapse.test.ts`; `npm run build`.
- **Готовность:** тесты приёмки раскладки из дополнения (детерминизм, отсутствие пересечений, добавление узла не двигает остальных, фильтр не двигает, `fitCamera.zoom ≥ 0.7` на 200 узлах), тесты сворачивания (цикл, родитель вне сцены, вложенность, `lifecycle_known=false`, error не сворачивается). Модуль не зависит от DOM/Canvas/Pixi.

### WP-D. Геометрия, движение, ввод
- **Файлы:** `frontend/src/scene/{geometry,motion,input}.ts` и `geometry.test.ts`, `motion.test.ts`.
- **Шаги:** 9, 10, 11d плана. `motion.ts` не зависит от Pixi (чистая функция). Состояния sleep/error/ended/stale/active — по визуальной спецификации.
- **Проверка:** `npm run test:unit -- src/scene/geometry.test.ts src/scene/motion.test.ts`; `npm run build`.
- **Готовность:** тесты шагов 9 и 10; в `input.ts` нет HTTP и RAF.

### WP-F. Арты и атлас
- **Файлы:** `tools/sprites/*` (включая `build_atlas.py`, `tools/sprites/raw/`), `frontend/public/scene/atlas/*`, `frontend/public/scene/providers/*`, `frontend/public/scene/ATTRIBUTION.txt`, `tests/test_sprites_tool.py`.
- **Шаги:** шаг 7 плана (SVG логотипов провайдеров, ATTRIBUTION) и дополнение, раздел D (скрипт атласа). Арты генерирует пользователь по `atlas-sprite-prompts.md` и кладёт в `tools/sprites/raw/`; до их появления тест скрипта идёт на синтетических PNG.
- **Проверка:** `python -m pytest tests/test_sprites_tool.py -q`; скрипт на синтетическом входе создаёт `objects.webp`, `fx.webp`, `atlas.json` по формату C5.
- **Готовность:** хромакей зелёного с despill, trim, упаковка ≤4096², anchors, premultiplied alpha; логотипы только из пакета `@lobehub/icons-static-svg@1.104.0`, без самодельных.

### WP-E. Renderer (PixiJS)
- **Файлы:** `frontend/src/scene/{renderer,paint,assets}.ts`, `frontend/src/scene/renderer.*.test.ts` (где тестируемо без WebGL).
- **Не трогать:** `model.ts`, `layout.ts`, `geometry.ts`, `motion.ts`, `input.ts` (использовать их как импорт), App/GraphView.
- **Шаги:** шаг 11 (подшаги 11a–f) в версии из **дополнения, раздел A, D**. Начать с **прототипа**: статическая отрисовка fixture на 200 узлов с запасными процедурными спрайтами (если атласа ещё нет) и скриншот, чтобы проверить читаемость раскладки до анимаций. Затем анимации, сворачивание потомков, visibility/reduced motion, `onToggleGroup`.
- **Проверка:** `npm run build`; `npm run test:unit`. Перед кодом прочитать API установленного `pixi.js` в `node_modules`.
- **Готовность:** публичный контракт `SceneRenderer` из шага 11 + `onToggleGroup`; один ticker; hidden останавливает; reduced motion статичен; отсутствующий спрайт → запасной объект и один `console.warn`.

### WP-G. Оболочка (GraphView и App)
- **Файлы:** `frontend/src/GraphView.tsx`, `frontend/src/App.tsx`, `frontend/src/styles.css`, `frontend/src/accessibility.css`.
- **Шаги:** 12 и 13 плана. До готовности WP-E использовать заглушку renderer из WP0; удаление Sigma/Graphology/FA2 выполнять **только после** слияния WP-E.
- **Проверка:** `npm run build`; `npm run test:unit`.
- **Готовность:** один renderer, нет FA2 worker, меню/popover/drawer/история/поиск по ТЗ, доступный список всех узлов, `expanded`-состояние и `onToggleGroup` подключены.

### WP-H. Приёмка и интеграция
- **Файлы:** `frontend/tests/scene.spec.ts` (использует fixture из WP-C), замеры, `build.ps1`-прогон.
- **Шаги:** 14 (с учётом Pixi и сворачивания, раздел E дополнения) и 15 плана.
- **Проверка:** `npm run test:visual`, `npm run test:unit`, `python -m pytest -q`; замер FPS на реальном ПК с GPU (headless — только для корректности).
- **Готовность:** критерии «Verification: итоговые критерии» плана и раздел E дополнения.

## 6. Что нельзя параллелить
- WP-E до слияния WP-C и WP-D (контракты ещё могут уточняться).
- Удаление Sigma — только после слияния WP-E.
- Правки `types.ts`, `package.json` — только через WP0/интегратора.

## 7. Проверки интегратора после каждого слияния
```
python -m pytest -q
cd frontend; npm run build; npm run test:unit
```
Если зелёное — следующий пакет. Если красное — пакет возвращается автору с выводом команды; другие ветки не сливаются, пока `main` красный.

## 8. Шаблон сообщения исполнителю
```
Ты разрабатываешь часть проекта Agent Atlas. Прикладываю:
1) atlas-visual-plan.md — основной план;
2) atlas-visual-plan-addendum.md — дополнение (приоритетнее основного плана);
3) atlas-work-split.md — разбиение на пакеты, правила и контракты.

Твой пакет — WP-<X>. Прочитай в atlas-work-split.md разделы 3 и 4 и свой пакет в разделе 5,
а в планах — только те шаги, на которые пакет ссылается.
Работай в ветке wp-<имя> (git worktree). Правь только файлы своего пакета.
Не выходи за пакет и не меняй контракты — пиши запрос в CONTRACT_CHANGES.md.
Сначала прочитай реальные исходники затрагиваемых файлов. Выполняй шаги по порядку,
после каждого запускай проверку. В конце верни отчёт: изменённые файлы,
вывод команд проверок, открытые вопросы, отклонения от плана.
```
