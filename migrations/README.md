# JASLIN Database Migrations

`004_security_hardening.sql` is the V6 migration created from the current hardening work.

`001_base.sql`, `002_x_tasks.sql`, and `003_auto_withdraw.sql` are currently
documentation placeholders and MUST NOT be executed. The exact historical
production schema must be exported/reconstructed first because JASLIN production
was originally built through earlier SQL Parts and patches.

Do not rerun old migrations on the current production database.
