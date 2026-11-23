# Agent Atlas

## Запуск

```bash
pip install fastapi uvicorn
python app.py
```

Откройте http://127.0.0.1:41735

## Журналы

Положите файлы в:

- `logs/codex-rollout.jsonl`
- `logs/omp.jsonl`

Пути можно изменить в `app.py` в списке `LOG_FILES`.

## Спрайты

Поместите 11 файлов WebP с прозрачностью в `static/sprites/`:

`agent.webp`, `tool.webp`, `project.webp`, `folder.webp`, `file.webp`, `site.webp`  
и при необходимости варианты для статусов: `agent-active.webp`, `agent-idle.webp`, `agent-sleeping.webp`, `agent-error.webp`, `agent-unknown.webp`.

Текущая страница использует базовые имена по типу узла; статусы меняются CSS-классом, поэтому анимация не сбрасывается.

## Принципы

- Состояние `unknown`, если в журнале нет начала или завершения хода.
- Модель и провайдер берутся только из явных метаданных.
- Рёбра создаются только реальными событиями вызова инструмента.
- Позиции файлов хранятся в памяти, тексты промптов и ответов не сохраняются.
