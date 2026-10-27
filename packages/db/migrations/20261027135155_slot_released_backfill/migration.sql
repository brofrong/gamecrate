-- Custom SQL migration file, put your code below! --
-- Старые `ended`/`failed` строки не знают про `slot_released_at` (колонка
-- появилась только сейчас): без бэкфилла частичный уникальный индекс по
-- `slot_released_at is null` (следующая миграция) упадёт на дублях слота
-- (например, несколько завершённых сессий на одном воркере и слоте). Если
-- контейнер такой строки на деле ещё жив на момент деплоя — её слот всё
-- равно будет считаться свободным; деплой делается только когда живых
-- сессий нет, так что это допустимо.
update sessions set slot_released_at = coalesce(ended_at, now()) where state in ('ended','failed') and slot is not null;
