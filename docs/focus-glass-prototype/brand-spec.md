# Obsidian Relay — визуальная спецификация

Источник: `packages/app/src/styles.css` исходного приложения и подтверждённый бриф от 19.10.2026. Бриф уточняет фон до нейтрального белого; фиолетовый акцент и жёлтый control режима ИИ взяты из действующего интерфейса.

```css
:root {
  --bg: oklch(97.6% 0.004 286);
  --surface: oklch(100% 0 0);
  --fg: oklch(20% 0.018 286);
  --muted: oklch(53% 0.025 286);
  --border: oklch(89% 0.018 286);
  --accent: oklch(50% 0.105 286);
  --font-display: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-body: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Consolas, monospace;
}
```

- Продуктовая оболочка отделяет спокойное рабочее полотно от подписанной навигации.
- Интервалы: 4, 8, 12, 16, 24, 32 и 48 px.
- Стекло ограничено навигацией и плавающими панелями; задачи и редакторы непрозрачны.
- Акцент маркирует выбранное и основное действие, жёлтый — только режим ИИ.
- Все интерактивные состояния сохраняют контраст и явный фокус.
