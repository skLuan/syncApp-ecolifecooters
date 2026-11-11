-- Compatible con MySQL 8 y MariaDB 10.6+ (Hostinger usa MariaDB).
-- payload se guarda como LONGTEXT (JSON serializado) para evitar diferencias entre motores.

CREATE TABLE IF NOT EXISTS sync_jobs (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  type          VARCHAR(64)  NOT NULL,
  -- Evita encolar dos veces el mismo evento (ej. "order:123:processing")
  dedupe_key    VARCHAR(191) NOT NULL,
  -- Entidad para buscar en el panel (ej. "order:123")
  entity_key    VARCHAR(191) NOT NULL,
  payload       LONGTEXT     NOT NULL,
  status        ENUM('pending','running','done','failed','dead') NOT NULL DEFAULT 'pending',
  attempts      INT UNSIGNED NOT NULL DEFAULT 0,
  run_after     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_by     VARCHAR(64)  NULL,
  locked_until  DATETIME     NULL,
  last_error    TEXT         NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sync_jobs_dedupe (dedupe_key),
  KEY ix_sync_jobs_claim (status, run_after),
  KEY ix_sync_jobs_entity (entity_key),
  KEY ix_sync_jobs_lock (locked_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Relación ID origen ↔ ID destino. El índice único es la barrera anti-duplicados.
CREATE TABLE IF NOT EXISTS id_map (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  entity       VARCHAR(32)  NOT NULL,   -- order | customer | product
  source       VARCHAR(32)  NOT NULL,   -- woocommerce
  source_id    VARCHAR(191) NOT NULL,
  target       VARCHAR(32)  NOT NULL,   -- odoo | zoho-books ...
  target_id    VARCHAR(191) NOT NULL,
  extra        TEXT         NULL,       -- JSON libre (ej. parent_id de una variación)
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_id_map_source (entity, source, source_id, target),
  KEY ix_id_map_target (entity, target, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historial para soporte (qué pasó con cada pedido).
CREATE TABLE IF NOT EXISTS sync_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id      BIGINT UNSIGNED NULL,
  entity_key  VARCHAR(191) NULL,
  level       ENUM('info','warn','error') NOT NULL DEFAULT 'info',
  message     TEXT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sync_log_entity (entity_key),
  KEY ix_sync_log_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Estado clave/valor (ej. cursor de la última sincronización de stock).
CREATE TABLE IF NOT EXISTS sync_state (
  `key`       VARCHAR(191) NOT NULL PRIMARY KEY,
  `value`     TEXT NOT NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
