-- Reserve the maximum charge before sending; missing prices and uncertain results cannot bypass a cap.
ALTER TABLE budgets ADD COLUMN daily_cost_limit numeric(14, 6) CHECK (daily_cost_limit >= 0);
ALTER TABLE budgets ADD COLUMN cost_currency text CHECK (cost_currency IN ('USD', 'CNY'));
ALTER TABLE budgets ADD CONSTRAINT budgets_cost_pair CHECK ((daily_cost_limit IS NULL) = (cost_currency IS NULL));
ALTER TABLE receipt_attempts ADD COLUMN reserved_cost numeric(14, 6) CHECK (reserved_cost >= 0);
ALTER TABLE receipt_attempts ADD COLUMN reserved_currency text;
ALTER TABLE service_prices ADD COLUMN endpoint_url text;
