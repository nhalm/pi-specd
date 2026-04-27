.PHONY: help install hooks lint fmt check fix

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  install           Install dependencies"
	@echo "  hooks             Install lefthook git hooks"
	@echo "  lint              Run ESLint"
	@echo "  fmt               Check formatting with Prettier"
	@echo "  check             Run all checks (lint + fmt)"
	@echo "  fix               Auto-fix lint and formatting"

install: ## Install dependencies
	npm install

hooks: ## Install lefthook git hooks
	npx lefthook install

lint: ## Run ESLint
	npx eslint .

fmt: ## Check formatting with Prettier
	npx prettier --check .

check: lint fmt ## Run all checks (lint + fmt)

fix: ## Auto-fix lint and formatting
	npx eslint --fix .
	npx prettier --write .