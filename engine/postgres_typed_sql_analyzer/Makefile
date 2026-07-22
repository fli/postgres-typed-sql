MODULE_big = postgres_typed_sql_analyzer
OBJS = $(patsubst %.c,%.o,$(wildcard *.c))

PG_CONFIG ?= pg_config
PGXS := $(shell $(PG_CONFIG) --pgxs)
include $(PGXS)
