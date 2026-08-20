-- Офисная витрина и заявки полностью отделены от розничного Maria Store.

ALTER TABLE prize_categories ADD COLUMN IF NOT EXISTS workspace VARCHAR(10) NOT NULL DEFAULT 'retail';
ALTER TABLE prizes ADD COLUMN IF NOT EXISTS workspace VARCHAR(10) NOT NULL DEFAULT 'retail';
ALTER TABLE store_exchanges ADD COLUMN IF NOT EXISTS workspace VARCHAR(10) NOT NULL DEFAULT 'retail';

ALTER TABLE prize_categories DROP CONSTRAINT IF EXISTS prize_categories_workspace_check;
ALTER TABLE prize_categories ADD CONSTRAINT prize_categories_workspace_check CHECK (workspace IN ('retail', 'office'));
ALTER TABLE prizes DROP CONSTRAINT IF EXISTS prizes_workspace_check;
ALTER TABLE prizes ADD CONSTRAINT prizes_workspace_check CHECK (workspace IN ('retail', 'office'));
ALTER TABLE store_exchanges DROP CONSTRAINT IF EXISTS store_exchanges_workspace_check;
ALTER TABLE store_exchanges ADD CONSTRAINT store_exchanges_workspace_check CHECK (workspace IN ('retail', 'office'));

CREATE INDEX IF NOT EXISTS idx_prize_categories_workspace ON prize_categories(workspace, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_prizes_workspace ON prizes(workspace, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_store_exchanges_workspace_status ON store_exchanges(workspace, status, created_at DESC);

INSERT INTO prize_categories(name, emoji, sort_order, workspace)
SELECT 'Офис', '🎧', 10, 'office'
WHERE NOT EXISTS (SELECT 1 FROM prize_categories WHERE workspace = 'office');
