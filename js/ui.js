/* ============================================================
 *  UI — связывает DOM с игровым движком
 * ============================================================ */

const CMD_ICON = { forward: "⬆️", right: "🔄" };

const $ = (id) => document.getElementById(id);

let game = null;
let heroKey = null;
let levelIndex = 0;
let program = [];

// ---------- Сообщения ----------
let msgTimer = null;
function showMessage(text, type = "") {
  const el = $("message");
  el.textContent = text;
  el.className = "message show " + type;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { el.className = "message " + type; }, 2200);
}

// ---------- Панель программы ----------
function renderProgram() {
  const list = $("programList");
  list.innerHTML = "";
  if (program.length === 0) {
    const hint = document.createElement("span");
    hint.className = "program-hint";
    hint.textContent = "⬆️ Шаг — вперёд на клетку. 🔄 Повернуть — на 90° вправо (3× = налево)";
    list.appendChild(hint);
    return;
  }
  program.forEach((cmd, i) => {
    const chip = document.createElement("div");
    chip.className = "cmd-chip";
    chip.dataset.index = i;
    chip.innerHTML = `<span class="idx">${i + 1}</span>${CMD_ICON[cmd]}`;
    chip.addEventListener("click", () => {
      if (game && game.running) return;
      program.splice(i, 1);
      renderProgram();
    });
    list.appendChild(chip);
  });
}

function highlightStep(index) {
  document.querySelectorAll(".cmd-chip").forEach(c => c.classList.remove("active"));
  if (index >= 0) {
    const chip = document.querySelector(`.cmd-chip[data-index="${index}"]`);
    if (chip) chip.classList.add("active");
  }
}

function setControlsEnabled(on) {
  ["runBtn", "clearBtn", "stepBackBtn"].forEach(id => { $(id).disabled = !on; });
  document.querySelectorAll(".cmd-btn").forEach(b => { b.disabled = !on; });
}

// ---------- Загрузка уровня ----------
async function startLevel(index) {
  levelIndex = index;
  const level = LEVELS[index];
  $("levelBadge").textContent = "Уровень " + (index + 1);
  $("levelName").textContent = level.name;
  program = [];
  renderProgram();
  highlightStep(-1);
  game.buildLevel(level);
  showMessage("Составь алгоритм и нажми «Запустить» ▶️");
}

// ---------- Результат ----------
function showResult(result) {
  setControlsEnabled(true);
  if (result.win) {
    let stars = 1;
    if (result.coins >= result.total / 2 && result.total > 0) stars = 2;
    if (result.coins >= result.total) stars = 3;
    if (result.total === 0) stars = 3;

    $("resultTitle").textContent = "🎉 Победа!";
    $("resultText").textContent =
      `Ты довёл героя до финиша! Монет собрано: ${result.coins} из ${result.total}.`;
    $("resultStars").textContent = "⭐".repeat(stars) + "☆".repeat(3 - stars);
    $("nextBtn").classList.remove("hidden");
    $("nextBtn").textContent = levelIndex < LEVELS.length - 1 ? "Дальше ➡️" : "🏆 Финал!";
    $("resultModal").classList.remove("hidden");
  } else {
    // Не победа — показываем подсказку прямо в игре, без модалки
    showMessage(result.reason, "bad");
  }
}

// ---------- Инициализация ----------
function bindUI() {
  // Выбор героя
  document.querySelectorAll(".hero-choice").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".hero-choice").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      heroKey = btn.dataset.hero;
      $("startBtn").disabled = false;
    });
  });

  // Старт игры
  $("startBtn").addEventListener("click", beginGame);

  // Палитра команд
  document.querySelectorAll(".cmd-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (game && game.running) return;
      program.push(btn.dataset.cmd);
      renderProgram();
    });
  });

  // Управление
  $("runBtn").addEventListener("click", async () => {
    if (!game || game.running || program.length === 0) {
      if (program.length === 0) showMessage("Сначала добавь команды! 👇");
      return;
    }
    setControlsEnabled(false);
    $("stepCount").textContent = program.length;
    game.setProgram(program);
    await game.run();
  });

  $("stepBackBtn").addEventListener("click", () => {
    if (game && game.running) return;
    program.pop();
    renderProgram();
  });

  $("clearBtn").addEventListener("click", () => {
    if (game && game.running) return;
    program = [];
    renderProgram();
  });

  $("resetBtn").addEventListener("click", () => {
    if (!game) return;
    game.reset();
    highlightStep(-1);
    setControlsEnabled(true);
    showMessage("Сброшено. Можно пробовать снова! 🔄");
  });

  // Модалка результата
  $("retryBtn").addEventListener("click", () => {
    $("resultModal").classList.add("hidden");
    game.reset();
    program = [];
    renderProgram();
  });

  $("nextBtn").addEventListener("click", async () => {
    $("resultModal").classList.add("hidden");
    if (levelIndex < LEVELS.length - 1) {
      await startLevel(levelIndex + 1);
    } else {
      $("resultTitle").textContent = "🏆 Все уровни пройдены!";
      $("resultText").textContent = "Ты настоящий капитан алгоритмов! Хочешь сыграть снова?";
      $("resultStars").textContent = "⭐⭐⭐";
      $("nextBtn").classList.add("hidden");
      $("resultModal").classList.remove("hidden");
      levelIndex = -1; // следующий retry перезапустит с 0... обработаем ниже
      $("retryBtn").textContent = "🔁 С начала";
      $("retryBtn").onclick = async () => {
        $("resultModal").classList.add("hidden");
        $("retryBtn").textContent = "🔄 Заново";
        $("retryBtn").onclick = null;
        bindRetryDefault();
        await startLevel(0);
      };
    }
  });
}

function bindRetryDefault() {
  $("retryBtn").onclick = () => {
    $("resultModal").classList.add("hidden");
    game.reset();
    program = [];
    renderProgram();
  };
}

async function beginGame() {
  $("startScreen").classList.add("hidden");
  $("loader").classList.remove("hidden");
  $("loaderText").textContent = "Загружаю остров...";

  game = new Game($("renderCanvas"));

  // Колбэки
  game.onStatus = (t, type) => showMessage(t, type);
  game.onStep = (i) => highlightStep(i);
  game.onCoin = (c, t) => {
    $("coinCount").textContent = c;
    $("coinTotal").textContent = t;
  };
  game.onComplete = (res) => showResult(res);

  try {
    // Грузим всё параллельно — так заметно быстрее.
    // Веса примерно по размеру файлов (МБ), чтобы полоса шла ровно.
    const W = { map: 8, sky: 5, coin: 9, hero: 28, pirates: 12 };
    const total = Object.values(W).reduce((a, b) => a + b, 0);
    const frac = { map: 0, sky: 0, coin: 0, hero: 0, pirates: 0 };
    const onProg = (key) => (e) => {
      frac[key] = e && e.lengthComputable && e.total ? e.loaded / e.total : frac[key];
      const pct = Math.round(
        Object.keys(W).reduce((s, k) => s + frac[k] * W[k], 0) / total * 100
      );
      $("loaderText").textContent = "Загружаю остров и героев... " + pct + "%";
    };
    await Promise.all([
      game.loadSkybox(),
      game.loadMap(onProg("map")),
      game.loadCollectibleTemplates(onProg("coin")),
      game.loadCharacter(heroKey, onProg("hero")),
      game.loadPirateTemplates(),
    ]);
  } catch (e) {
    console.error(e);
    $("loaderText").textContent = "Ошибка загрузки моделей. Запусти через локальный сервер (см. README).";
    return;
  }

  $("loader").classList.add("hidden");
  $("hud").classList.remove("hidden");
  $("programPanel").classList.remove("hidden");

  await startLevel(0);
}

document.addEventListener("DOMContentLoaded", bindUI);
