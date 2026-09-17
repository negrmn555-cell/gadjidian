export function InstallGate() {
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  return (
    <div className="screen">
      <div className="center">
        <h1>Установите приложение</h1>
        <p className="muted">
          Из обычной вкладки браузера вход закрыт: код подключения — ключ от ваших заметок, а вкладку легко потерять. Добавьте страницу
          на домашний экран и открывайте с иконки.
        </p>
        {ios ? (
          <ol className="muted">
            <li>Нажмите «Поделиться» (квадрат со стрелкой) внизу Safari</li>
            <li>Выберите «На экран “Домой”»</li>
            <li>Нажмите «Добавить» и откройте с иконки</li>
          </ol>
        ) : (
          <ol className="muted">
            <li>Меню браузера (три точки)</li>
            <li>«Установить приложение» или «Добавить на главный экран»</li>
            <li>Откройте с иконки</li>
          </ol>
        )}
      </div>
    </div>
  );
}
