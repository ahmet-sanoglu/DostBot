-- Mevcut DB'ye run_id ekler (CREATE TABLE IF NOT EXISTS mevcut sütunları güncellemez).
-- Neden? Aynı task_name için orphan "başlatıldı" FIFO'yu kaydırıyordu; tamamlanan run
-- "yarım kaldı" görünüyordu. run_id ile başlat/bitir birebir bağlanır.
ALTER TABLE task_history ADD COLUMN IF NOT EXISTS run_id TEXT;
-- Harita + run_id ile birleştirme taramasını ucuzlatır
CREATE INDEX IF NOT EXISTS idx_task_history_run ON task_history(map_id, run_id);
