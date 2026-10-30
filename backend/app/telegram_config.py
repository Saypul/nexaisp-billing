"""Telegram settings shared by the API and polling worker."""
import base64
import hashlib
import os
import json

from cryptography.fernet import Fernet, InvalidToken

from .models import TelegramConfig

DEFAULT_CATEGORY_TEAMS = {
    'METRO_E': 'technician', 'DEDICATED': 'technician', 'FTTH': 'technician', 'TUNNEL': 'noc',
}


def cipher():
    secret = os.environ['JWT_SECRET'].encode('utf-8')
    key = base64.urlsafe_b64encode(hashlib.sha256(b'nexaisp-telegram-v1:' + secret).digest())
    return Fernet(key)


def get_bot_token(db):
    config = db.get(TelegramConfig, 1)
    if config and config.encrypted_bot_token:
        try:
            return cipher().decrypt(config.encrypted_bot_token.encode('utf-8')).decode('utf-8')
        except InvalidToken:
            return ''
    return os.getenv('TELEGRAM_BOT_TOKEN', '').strip()


def get_admin_chat_id(db):
    config = db.get(TelegramConfig, 1)
    if config:
        return config.admin_chat_id
    value = os.getenv('TELEGRAM_ADMIN_CHAT_ID', '').strip()
    return int(value) if value.lstrip('-').isdigit() else None


def get_work_order_chat_id(db):
    config = db.get(TelegramConfig, 1)
    return config.work_order_chat_id if config else None


def get_category_teams(db):
    config = db.get(TelegramConfig, 1)
    custom = json.loads(config.category_teams) if config and config.category_teams else {}
    return {**DEFAULT_CATEGORY_TEAMS, **{k: v for k, v in custom.items() if k in DEFAULT_CATEGORY_TEAMS}}


def get_ticket_team(db, ticket):
    category = ticket.subscription.plan.category if ticket.subscription else None
    return get_category_teams(db).get(category) if category else None


def get_ticket_chat_id(db, ticket):
    team = get_ticket_team(db, ticket)
    config = db.get(TelegramConfig, 1)
    return (config.noc_chat_id if config else None) if team == 'noc' else get_work_order_chat_id(db) if team == 'technician' else None


def get_allowed_group_ids(db):
    config = db.get(TelegramConfig, 1)
    groups = {config.noc_chat_id} if config else set()
    groups.add(get_work_order_chat_id(db))
    groups.discard(None)
    return groups
