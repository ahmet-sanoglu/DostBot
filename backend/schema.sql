-- AgriFleet PostgreSQL şeması — JSON dosya deposunun yerine geçer.
-- Neden SQL? Eşzamanlı yazım, atomik güncelleme ve harita silince ilişkili verinin
-- CASCADE ile temizlenmesi; dosya kilit / yarım yazım riski yok.
-- API camelCase döner; sütunlar snake_case (SQL geleneği) — çeviri app.py'de.

CREATE TABLE IF NOT EXISTS maps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image_dir TEXT NOT NULL,  -- PNG/YAML disk yolu; görüntü DB'de değil (büyük binary)
    is_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Harita silinince görevler de gitsin (yetim kayıt / yanlış haritada görev kalmasın)
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    map_id TEXT REFERENCES maps(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    pinned BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Adımlar ayrı tablo: sıra (step_order) net; görev güncellemesinde DELETE+INSERT kolay
CREATE TABLE IF NOT EXISTS task_steps (
    id SERIAL PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    step_order INTEGER NOT NULL,
    x DOUBLE PRECISION NOT NULL,
    y DOUBLE PRECISION NOT NULL,
    yaw DOUBLE PRECISION DEFAULT 0,
    action_type TEXT DEFAULT 'wait'
);

CREATE TABLE IF NOT EXISTS forbidden_zones (
    id TEXT PRIMARY KEY,
    map_id TEXT REFERENCES maps(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    x_min DOUBLE PRECISION,
    x_max DOUBLE PRECISION,
    y_min DOUBLE PRECISION,
    y_max DOUBLE PRECISION
);

-- Poligon değişken uzunlukta → JSONB; ayrı vertex tablosu gereksiz karmaşa olurdu
CREATE TABLE IF NOT EXISTS boundaries (
    map_id TEXT PRIMARY KEY REFERENCES maps(id) ON DELETE CASCADE,
    points JSONB NOT NULL
);

-- Yan log: nav state makinesinden bağımsız; harita bazlı UI geçmişi
CREATE TABLE IF NOT EXISTS task_history (
    id SERIAL PRIMARY KEY,
    map_id TEXT REFERENCES maps(id) ON DELETE CASCADE,
    task_name TEXT NOT NULL,
    status TEXT NOT NULL,
    timestamp TIMESTAMPTZ DEFAULT now()
);

-- Modal "en yeni üstte" listeler; harita+zaman indeksi tarama maliyetini düşürür
CREATE INDEX IF NOT EXISTS idx_task_history_map ON task_history(map_id, timestamp DESC);
