/* ============================================================
 *  Пиратские Алгоритмы — игровой движок на Babylon.js
 * ============================================================ */

const ASSET_DIR = "assets/models/";

// --- Настройки, которые удобно крутить ---
const CELL = 2;            // размер клетки (поперёк поля — 3 ряда)
const CELL_LONG = CELL; // размер клетки вдоль длинной оси поля (квадратные клетки)
const HERO_HEIGHT = 1.8;   // желаемая высота героя в мире
const MOVE_MS = 480;       // длительность шага вперёд
const TURN_MS = 320;       // длительность поворота
const BUMP_MS = 320;       // длительность "удара о стену"
// Поворот игровой сетки: 0=нет, 1=90° влево (CCW), 2=180°, 3=90° вправо
const GRID_ROTATION_STEPS = 1;
// Сдвиг игровой сетки по Y относительно y=0 (основания карты)
const GRID_Y_OFFSET = 9.5;
// Смещение всего поля в мировых координатах (вправо = +X, вперёд = +Z)
const GRID_OFFSET_X = 3;
const GRID_OFFSET_Z = 0;
// Поправка разворота модели. Если герой бежит "боком" — поставь
// Math.PI/2, -Math.PI/2 или Math.PI, пока не встанет лицом по ходу.
const HERO_YAW_OFFSET = 0;
const HERO_MODEL_YAW = Math.PI / 2;
const CAMERA_ALPHA_OFFSET = Math.PI;
const CAMERA_BETA = 1.18;
const CAMERA_DISTANCE = 9;
const CAMERA_FOLLOW_LERP = 0.12;

// Направления (по часовой стрелке): N -> E -> S -> W
const DIR_ORDER = ["N", "E", "S", "W"];
const DIR_VEC = {
  N: { dx: 0, dz: -1 },
  E: { dx: 1, dz: 0 },
  S: { dx: 0, dz: 1 },
  W: { dx: -1, dz: 0 },
};

function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    this.scene = new BABYLON.Scene(this.engine);
    this.scene.clearColor = new BABYLON.Color4(0.12, 0.45, 0.55, 1);

    // Колбэки для UI (назначаются снаружи)
    this.onStatus = null;   // (text, type)
    this.onCoin = null;     // (collected, total)
    this.onStep = null;     // (index | -1)
    this.onComplete = null; // (result)

    this.program = [];
    this.running = false;
    this.aborted = false;
    this.gridY = 0;

    this._setupCamera();
    this._setupLights();

    this.engine.runRenderLoop(() => {
      this._updateCameraFollow();
      this.scene.render();
    });
    window.addEventListener("resize", () => this.engine.resize());
  }

  _setupCamera() {
    const cam = new BABYLON.ArcRotateCamera(
      "cam", CAMERA_ALPHA_OFFSET, CAMERA_BETA, 30, BABYLON.Vector3.Zero(), this.scene);
    cam.attachControl(this.canvas, true);
    cam.lowerBetaLimit = 0.25;
    cam.upperBetaLimit = 1.45;
    cam.lowerRadiusLimit = 3;
    cam.upperRadiusLimit = 120;
    cam.wheelPrecision = 8;
    cam.panningSensibility = 0;
    this.camera = cam;
  }

  _setupLights() {
    const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.85;
    hemi.groundColor = new BABYLON.Color3(0.3, 0.35, 0.4);

    const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.5, -1, 0.6), this.scene);
    sun.intensity = 1.1;
    sun.position = new BABYLON.Vector3(20, 40, -20);
    this.sun = sun;
  }

  // ---------------------------------------------------------
  //  Загрузка карты
  // ---------------------------------------------------------
  async loadMap(onProgress) {
    const res = await BABYLON.SceneLoader.ImportMeshAsync("", ASSET_DIR, "game_pirate_adventure_map.glb", this.scene, onProgress);
    const root = res.meshes[0];
    root.computeWorldMatrix(true);

    // Масштабируем карту, чтобы она была примерно вдвое крупнее игровой сетки
    let b = root.getHierarchyBoundingVectors();
    const sizeX = b.max.x - b.min.x;
    const sizeZ = b.max.z - b.min.z;
    const footprint = Math.max(sizeX, sizeZ) || 1;
    const targetFootprint = 198; // мир-единицы (сетка обычно меньше)
    const scale = targetFootprint / footprint;
    root.scaling.setAll(scale);
    root.computeWorldMatrix(true);

    // Центрируем по XZ; по Y ставим основание карты в 0
    b = root.getHierarchyBoundingVectors();
    const cx = (b.max.x + b.min.x) / 2;
    const cz = (b.max.z + b.min.z) / 2;
    root.position.x -= cx;
    root.position.z -= cz;
    root.position.y -= b.min.y;   // min.y → 0
    root.computeWorldMatrix(true);

    // Игровая доска — прямо на y=0 (на поверхности карты)
    b = root.getHierarchyBoundingVectors();
    this.gridY = 0 + GRID_Y_OFFSET;
    this._mapSizeX = b.max.x - b.min.x;
    this._mapSizeZ = b.max.z - b.min.z;
    this.mapRoot = root;
  }

  async loadSkybox() {
    const res = await BABYLON.SceneLoader.ImportMeshAsync("", ASSET_DIR, "skybox.glb", this.scene);
    const root = res.meshes[0];
    this.scene.clearColor = new BABYLON.Color4(0, 0, 0, 1);
    root.scaling.setAll(800);
    root.infiniteDistance = true;
    res.meshes.forEach(m => {
      if (!m.material) return;
      m.material.backFaceCulling = false;
      m.material.disableDepthWrite = true;
      m.isPickable = false;
    });
    this.skyboxRoot = root;
  }

  // Предзагрузка шаблонов монеты/буста (один раз)
  async loadCollectibleTemplates(onProgress) {
    const res = await BABYLON.SceneLoader.ImportMeshAsync("", ASSET_DIR, "coin.glb", this.scene, onProgress);
    const root = res.meshes[0];
    root.computeWorldMatrix(true);
    const b = root.getHierarchyBoundingVectors();
    const h = (b.max.y - b.min.y) || 1;
    root.scaling.setAll(0.9 / h);
    root.setEnabled(false);
    this.coinTemplate = root;
  }

  async loadPirateTemplates() {
    const files = ["pirate_one.glb", "pirate_two.glb", "pirate_three.glb", "pirate_fourglb.glb"];
    this.pirateTemplates = await Promise.all(files.map(async (file) => {
      const res = await BABYLON.SceneLoader.ImportMeshAsync("", ASSET_DIR, file, this.scene);
      const root = res.meshes[0];
      root.computeWorldMatrix(true);
      const b = root.getHierarchyBoundingVectors();
      const h = (b.max.y - b.min.y) || 1;
      root.scaling.setAll((HERO_HEIGHT * 0.92) / h);
      root.computeWorldMatrix(true);
      root._feetMinY = root.getHierarchyBoundingVectors().min.y;
      root.setEnabled(false);
      return root;
    }));
  }

  // ---------------------------------------------------------
  //  Загрузка персонажа
  // ---------------------------------------------------------
  async loadCharacter(heroKey, onProgress) {
    const file = heroKey === "girl" ? "girl.glb" : "boy.glb";
    const res = await BABYLON.SceneLoader.ImportMeshAsync("", ASSET_DIR, file, this.scene, onProgress);
    const root = res.meshes[0];
    root.computeWorldMatrix(true);

    // Масштаб под высоту клетки
    let b = root.getHierarchyBoundingVectors();
    const h = (b.max.y - b.min.y) || 1;
    const scale = HERO_HEIGHT / h;
    root.scaling.setAll(scale);
    root.computeWorldMatrix(true);
    b = root.getHierarchyBoundingVectors();
    this.heroFeetMinY = b.min.y;

    const pivot = new BABYLON.TransformNode("heroPivot", this.scene);
    const modelYaw = new BABYLON.TransformNode("heroModelYaw", this.scene);
    modelYaw.parent = pivot;
    modelYaw.rotation.y = HERO_MODEL_YAW;
    root.parent = modelYaw;

    this.hero = pivot;
    this.heroModel = root;

    // Анимации — точные имена по персонажу
    const groups = res.animationGroups || [];
    groups.forEach(g => g.stop());
    const byName = (name) => groups.find(g => g.name === name) || null;
    const isGirl = heroKey === "girl";

    this.animWalk = byName("Running");
    this.animIdle = byName(isGirl ? "Idle_6" : "Idle_11");
    this.animWin  = byName(isGirl ? "Jump_Rope" : "happy_jump_m");
    this._currentAnim = null;
    this._playAnim(this.animIdle);
  }

  _playAnim(group) {
    if (this._currentAnim === group) return;
    if (this._currentAnim) this._currentAnim.stop();
    if (group) group.start(true, 1.0, group.from, group.to, false);
    this._currentAnim = group || null;
  }

  // ---------------------------------------------------------
  //  Построение уровня
  // ---------------------------------------------------------
  buildLevel(level) {
    this._clearLevel();
    this.level = level;
    this.grid = level.grid.map(r => r.split(""));
    this.rows = this.grid.length;
    this.cols = Math.max(...this.grid.map(r => r.length));

    this.tiles = [];
    this.pirates = [];
    this.collectibles = new Map();
    this.coinCount = 0;
    this.coinTotal = 0;

    // Найти старт/финиш
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const ch = this.grid[r][c] || ".";
        if (ch === "S") this.start = { row: r, col: c };
        if (ch === "F") this.finish = { row: r, col: c };
      }
    }

    // Поворачиваем остров так, чтобы его длинная сторона шла вдоль
    // длинной стороны поля с учётом поворота сетки.
    if (this.mapRoot) {
      const gridLongIsXOrig = this.cols >= this.rows;
      // нечётный шаг поворота сетки меняет ориентацию её длинной оси
      const gridLongIsX = (GRID_ROTATION_STEPS % 2 === 0) ? gridLongIsXOrig : !gridLongIsXOrig;
      const mapLongIsX = (this._mapSizeX || 1) >= (this._mapSizeZ || 1);
      this.mapRoot.rotation.y = (gridLongIsX === mapLongIsX) ? Math.PI : Math.PI * 1.5;
    }

    this._buildTiles();
    this._buildEntities();
    this._buildSpinObserver();

    // Камера на стартовую позицию игрока, поближе
    const startWorld = this.cellToWorld(this.start.row, this.start.col, this.gridY);
    this.camera.setTarget(startWorld);
    this.camera.radius = CAMERA_DISTANCE;

    this.placeHeroAtStart();
    if (this.onCoin) this.onCoin(this.coinCount, this.coinTotal);
  }

  cellToWorld(row, col, y) {
    // cx — длинная ось (колонки), cz — короткая (ряды)
    const cx = (col - (this.cols - 1) / 2) * CELL_LONG;
    const cz = (row - (this.rows - 1) / 2) * CELL;
    let wx, wz;
    switch (GRID_ROTATION_STEPS % 4) {
      case 1: wx = -cz; wz =  cx; break; // 90° CCW (влево)
      case 2: wx = -cx; wz = -cz; break; // 180°
      case 3: wx =  cz; wz = -cx; break; // 90° CW  (вправо)
      default: wx = cx; wz = cz;          // 0° — без поворота
    }
    return new BABYLON.Vector3(wx + GRID_OFFSET_X, y === undefined ? this.gridY : y, wz + GRID_OFFSET_Z);
  }

  _buildTiles() {
    const matA = new BABYLON.StandardMaterial("tA", this.scene);
    matA.diffuseColor = new BABYLON.Color3(0.92, 0.81, 0.56);
    const matB = new BABYLON.StandardMaterial("tB", this.scene);
    matB.diffuseColor = new BABYLON.Color3(0.82, 0.70, 0.45);
    matA.specularColor = matB.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        // Прямоугольный тайл: короткая ось = CELL, длинная = CELL_LONG
        // При GRID_ROTATION_STEPS=1: width→мировой X (ряды=CELL), depth→Z (колонки=CELL_LONG)
        const tile = BABYLON.MeshBuilder.CreateBox("tile", {
          width: CELL * 0.99, depth: CELL_LONG * 0.99, height: 0.15,
        }, this.scene);
        const p = this.cellToWorld(r, c, this.gridY - 0.075);
        tile.position = p;
        tile.material = (r + c) % 2 === 0 ? matA : matB;
        tile.receiveShadows = true;
        this.tiles.push(tile);
      }
    }
  }

  _buildEntities() {
    let pirateIdx = 0;

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const ch = this.grid[r][c] || ".";
        if (ch === "#") {
          const templates = this.pirateTemplates;
          if (templates && templates.length) {
            const tpl = templates[pirateIdx % templates.length];
            pirateIdx++;
            // instantiateHierarchy корректно копирует весь GLB-граф с дочерними мешами
            const inst = tpl.instantiateHierarchy(null, { newNamePrefix: "p" + r + "_" + c + "_" });
            inst.setEnabled(true);
            // GLB-иерархии используют quaternion — обнуляем, чтобы работали Euler-углы
            inst.rotationQuaternion = null;
            inst.position = this.cellToWorld(r, c, this.gridY - tpl._feetMinY);
            inst.rotation.y = Math.random() * Math.PI * 2;
            inst.metadata = { phase: Math.random() * Math.PI * 2, baseY: inst.position.y };
            this.pirates.push(inst);
          } else {
            // запасной куб если модели не загрузились
            const pirateMat = new BABYLON.StandardMaterial("pirateCube", this.scene);
            pirateMat.diffuseColor = new BABYLON.Color3(0.75, 0.18, 0.16);
            const box = BABYLON.MeshBuilder.CreateBox("pirate", { size: CELL * 0.66 }, this.scene);
            box.position = this.cellToWorld(r, c, this.gridY + CELL * 0.33);
            box.material = pirateMat;
            this.pirates.push(box);
          }
        } else if (ch === "C") {
          this._addCollectible(r, c, "coin", 1);
        } else if (ch === "B") {
          this._addCollectible(r, c, "boost", 3);
        }
      }
    }

    if (this.start) this._buildStartMarker(this.start);
    if (this.finish) this._buildFinishMarker(this.finish);
  }

  _addCollectible(row, col, type, value) {
    let mesh;
    if (type === "coin" && this.coinTemplate) {
      mesh = this.coinTemplate.clone("coin_" + row + "_" + col);
      mesh.setEnabled(true);
      mesh.position = this.cellToWorld(row, col, this.gridY + 0.7);
      // наклон чтобы монета стояла «ребром» — тогда вращение по Y будет видно
      mesh.rotation.x = Math.PI / 2;
    } else {
      // Буст — светящийся изумруд
      mesh = BABYLON.MeshBuilder.CreatePolyhedron("boost", { type: 1, size: 0.55 }, this.scene);
      const m = new BABYLON.StandardMaterial("boostMat", this.scene);
      m.diffuseColor = new BABYLON.Color3(0.1, 0.8, 0.4);
      m.emissiveColor = new BABYLON.Color3(0.1, 0.6, 0.3);
      mesh.material = m;
      mesh.position = this.cellToWorld(row, col, this.gridY + 0.8);
    }
    this.collectibles.set(row + "," + col, { mesh, type, value, collected: false });
    this.coinTotal += value;
  }

  _buildStartMarker(s) {
    const ring = BABYLON.MeshBuilder.CreateTorus("startRing",
      { diameter: CELL * 0.7, thickness: 0.12, tessellation: 24 }, this.scene);
    ring.position = this.cellToWorld(s.row, s.col, this.gridY + 0.05);
    const m = new BABYLON.StandardMaterial("startMat", this.scene);
    m.emissiveColor = new BABYLON.Color3(0.2, 0.7, 0.9);
    m.diffuseColor = new BABYLON.Color3(0.2, 0.7, 0.9);
    ring.material = m;
    this.startMarker = ring;
  }

  _buildFinishMarker(f) {
    const pole = BABYLON.MeshBuilder.CreateCylinder("pole",
      { height: 2.2, diameter: 0.12 }, this.scene);
    pole.position = this.cellToWorld(f.row, f.col, this.gridY + 1.1);
    const poleMat = new BABYLON.StandardMaterial("poleMat", this.scene);
    poleMat.diffuseColor = new BABYLON.Color3(0.4, 0.25, 0.1);
    pole.material = poleMat;

    const flag = BABYLON.MeshBuilder.CreatePlane("flag", { width: 1.0, height: 0.7 }, this.scene);
    flag.position = this.cellToWorld(f.row, f.col, this.gridY + 1.75);
    flag.position.x += 0.5;
    const flagMat = new BABYLON.StandardMaterial("flagMat", this.scene);
    flagMat.diffuseColor = new BABYLON.Color3(0.95, 0.85, 0.2);
    flagMat.emissiveColor = new BABYLON.Color3(0.4, 0.35, 0.05);
    flagMat.backFaceCulling = false;
    flag.material = flagMat;

    const disc = BABYLON.MeshBuilder.CreateDisc("finishDisc",
      { radius: CELL * 0.42, tessellation: 32 }, this.scene);
    disc.rotation.x = Math.PI / 2;
    disc.position = this.cellToWorld(f.row, f.col, this.gridY + 0.06);
    const discMat = new BABYLON.StandardMaterial("discMat", this.scene);
    discMat.emissiveColor = new BABYLON.Color3(0.95, 0.8, 0.2);
    discMat.alpha = 0.6;
    disc.material = discMat;

    this.finishMeshes = [pole, flag, disc];
  }

  _buildSpinObserver() {
    if (this._spinObserver) this.scene.onBeforeRenderObservable.remove(this._spinObserver);
    this._spinObserver = this.scene.onBeforeRenderObservable.add(() => {
      const dt = this.engine.getDeltaTime() / 1000;
      this.collectibles.forEach(it => {
        if (!it.collected) {
          it.mesh.rotation.y += dt * 4.5;
          it.mesh.rotation.z += dt * 3.0;
          it.mesh.position.y += Math.sin(performance.now() / 400 + it.mesh.position.x) * 0.003;
        }
      });

      // Покачивание пиратов
      const t = performance.now() / 1000;
      this.pirates.forEach(p => {
        if (!p.metadata) return;
        const ph = p.metadata.phase;
        p.rotation.z = Math.sin(t * 1.4 + ph) * 0.18;
        p.rotation.x = Math.sin(t * 0.9 + ph + 1.2) * 0.10;
        p.position.y = p.metadata.baseY + Math.sin(t * 1.1 + ph) * 0.06;
      });
    });
  }

  _clearLevel() {
    const dispose = (arr) => arr && arr.forEach(m => m && m.dispose());
    dispose(this.tiles);
    dispose(this.pirates);
    dispose(this.finishMeshes);
    if (this.startMarker) this.startMarker.dispose();
    if (this.collectibles) this.collectibles.forEach(it => it.mesh.dispose());
    this.tiles = []; this.pirates = []; this.finishMeshes = [];
    this.startMarker = null;
    this.collectibles = new Map();
  }

  // ---------------------------------------------------------
  //  Герой: позиционирование
  // ---------------------------------------------------------
  placeHeroAtStart() {
    const s = this.start || { row: 0, col: 0 };
    this.pos = { row: s.row, col: s.col };
    this.dir = DIR_ORDER.indexOf(this.level.startDir || "S");
    if (this.dir < 0) this.dir = 2;

    const w = this.cellToWorld(s.row, s.col, this.gridY - this.heroFeetMinY);
    this.hero.position.copyFrom(w);
    this.hero.rotation.y = this._dirAngle(this.dir);
    this._updateCameraFollow(true);
    this._playAnim(this.animIdle);
  }

  _dirAngle(dirIdx) {
    const v = DIR_VEC[DIR_ORDER[dirIdx]];
    return Math.atan2(v.dx, v.dz) + HERO_YAW_OFFSET;
  }

  _updateCameraFollow(immediate = false) {
    if (!this.camera || !this.hero) return;

    const target = this.hero.position.add(new BABYLON.Vector3(0, HERO_HEIGHT * 0.85, 0));
    const lerp = immediate ? 1 : CAMERA_FOLLOW_LERP;
    const currentTarget = this.camera.target || target;
    this.camera.target = BABYLON.Vector3.Lerp(currentTarget, target, lerp);

    const toAlpha = this.hero.rotation.y + CAMERA_ALPHA_OFFSET;
    let delta = toAlpha - this.camera.alpha;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.camera.alpha += delta * lerp;
    this.camera.beta += (CAMERA_BETA - this.camera.beta) * lerp;
    this.camera.radius += (CAMERA_DISTANCE - this.camera.radius) * lerp;
  }

  // ---------------------------------------------------------
  //  Tween-помощник
  // ---------------------------------------------------------
  _tween(durMs, onUpdate) {
    return new Promise((resolve) => {
      const start = performance.now();
      const obs = this.scene.onBeforeRenderObservable.add(() => {
        const t = Math.min(1, (performance.now() - start) / durMs);
        onUpdate(easeInOutQuad(t), t);
        if (t >= 1) {
          this.scene.onBeforeRenderObservable.remove(obs);
          resolve();
        }
      });
    });
  }

  // ---------------------------------------------------------
  //  Исполнение алгоритма
  // ---------------------------------------------------------
  setProgram(program) { this.program = program.slice(); }

  async run() {
    if (this.running || !this.program.length) return null;
    this.running = true;
    this.aborted = false;

    let result = { win: false, reason: "", coins: this.coinCount, total: this.coinTotal };

    for (let i = 0; i < this.program.length; i++) {
      if (this.aborted) { this.running = false; return null; }
      if (this.onStep) this.onStep(i);
      const cmd = this.program[i];

      if (cmd === "left" || cmd === "right") {
        await this._turn(cmd);
      } else if (cmd === "forward") {
        const moved = await this._forward();
        if (this.aborted) { this.running = false; return null; }
        if (!moved.ok) {
          result.reason = moved.reason;
          this.running = false;
          if (this.onStep) this.onStep(-1);
          if (this.onComplete) this.onComplete(result);
          return result;
        }
        if (moved.win) {
          result.win = true;
          result.coins = this.coinCount;
          this.running = false;
          if (this.onStep) this.onStep(-1);
          this._playAnim(this.animWin);
          // даём победной анимации поиграть 1.8 с перед модалкой
          await new Promise(r => setTimeout(r, 1800));
          if (this.onComplete) this.onComplete(result);
          return result;
        }
      }
    }

    if (this.onStep) this.onStep(-1);
    this.running = false;
    result.coins = this.coinCount;
    if (!result.win) result.reason = "Алгоритм закончился, а финиш не достигнут. Попробуй ещё!";
    if (this.onComplete) this.onComplete(result);
    return result;
  }

  async _turn(side) {
    this.dir = side === "right"
      ? (this.dir + 1) % 4
      : (this.dir + 3) % 4;
    const from = this.hero.rotation.y;
    let to = this._dirAngle(this.dir);
    // кратчайший поворот
    let delta = to - from;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    await this._tween(TURN_MS, (e) => {
      this.hero.rotation.y = from + delta * e;
    });
  }

  async _forward() {
    const v = DIR_VEC[DIR_ORDER[this.dir]];
    const nr = this.pos.row + v.dz;
    const nc = this.pos.col + v.dx;

    // За краем карты?
    if (nr < 0 || nr >= this.rows || nc < 0 || nc >= this.cols) {
      await this._bump(v);
      return { ok: false, reason: "Ой! Это край карты — туда нельзя. 🌊" };
    }
    const ch = this.grid[nr][nc] || ".";
    // Пират?
    if (ch === "#") {
      await this._bump(v);
      return { ok: false, reason: "Стоп! Впереди пират! ☠️ Нужно его обойти." };
    }

    // Двигаемся
    const fromPos = this.hero.position.clone();
    const toPos = this.cellToWorld(nr, nc, this.gridY - this.heroFeetMinY);
    this._playAnim(this.animWalk);
    await this._tween(MOVE_MS, (e) => {
      this.hero.position = BABYLON.Vector3.Lerp(fromPos, toPos, e);
    });
    this._playAnim(this.animIdle);

    this.pos = { row: nr, col: nc };
    this._tryCollect(nr, nc);

    // Финиш?
    if (this.finish && nr === this.finish.row && nc === this.finish.col) {
      return { ok: true, win: true };
    }
    return { ok: true, win: false };
  }

  async _bump(v) {
    this._playAnim(this.animWalk);
    const fromPos = this.hero.position.clone();
    const peak = fromPos.add(new BABYLON.Vector3(v.dx * CELL * 0.3, 0, v.dz * CELL * 0.3));
    await this._tween(BUMP_MS, (e) => {
      // вперёд и обратно
      const k = e < 0.5 ? e * 2 : (1 - e) * 2;
      this.hero.position = BABYLON.Vector3.Lerp(fromPos, peak, k);
    });
    this.hero.position.copyFrom(fromPos);
    this._playAnim(this.animIdle);
  }

  _tryCollect(row, col) {
    const key = row + "," + col;
    const it = this.collectibles.get(key);
    if (it && !it.collected) {
      it.collected = true;
      this.coinCount += it.value;
      // эффект сбора: подпрыгнуть и исчезнуть
      this._tween(280, (e) => {
        it.mesh.scaling.setAll(0.9 * (1 - e) + 0.001);
        it.mesh.position.y += 0.03;
      }).then(() => it.mesh.setEnabled(false));
      if (this.onCoin) this.onCoin(this.coinCount, this.coinTotal);
      if (this.onStatus) {
        this.onStatus(it.type === "boost" ? "Буст! +3 🪙" : "+1 🪙", "ok");
      }
    }
  }

  // ---------------------------------------------------------
  //  Сброс
  // ---------------------------------------------------------
  reset() {
    this.aborted = true;
    this.running = false;
    if (this.onStep) this.onStep(-1);
    // вернуть собранные предметы на место
    this.coinCount = 0;
    this.collectibles.forEach(it => {
      it.collected = false;
      if (it.type === "coin" && this.coinTemplate) {
        it.mesh.scaling.copyFrom(this.coinTemplate.scaling);
      } else {
        it.mesh.scaling.setAll(1);
      }
      it.mesh.setEnabled(true);
    });
    this.placeHeroAtStart();
    if (this.onCoin) this.onCoin(this.coinCount, this.coinTotal);
  }
}
