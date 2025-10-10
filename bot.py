import os
import logging
import asyncio
import aiohttp
import json
from telegram import Update, ReplyKeyboardMarkup, KeyboardButton, ReplyKeyboardRemove
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes, MessageHandler, filters
import qrcode
import io
from datetime import datetime, timedelta
import re

# Configuration
TOKEN = os.getenv('TELEGRAM_BOT_TOKEN')
ADMIN_IDS = [int(x) for x in os.getenv('TELEGRAM_ADMIN_IDS', '').split(',') if x]
NODE_API_URL = os.getenv('NODE_API_URL', 'http://localhost:3000')
SUPPORT_CONTACT = "@Nova_king0"

# Setup logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

class NovaMDTelegramBot:
    def __init__(self):
        self.application = Application.builder().token(TOKEN).build()
        self.setup_handlers()
        
    def setup_handlers(self):
        # Commandes utilisateur
        self.application.add_handler(CommandHandler("start", self.start))
        self.application.add_handler(CommandHandler("help", self.help))
        self.application.add_handler(CommandHandler("use_code", self.use_code))
        self.application.add_handler(CommandHandler("subscribe", self.subscribe_info))
        self.application.add_handler(CommandHandler("connect", self.connect_options))
        self.application.add_handler(CommandHandler("status", self.status))
        self.application.add_handler(CommandHandler("menu", self.show_main_menu))
        self.application.add_handler(CommandHandler("whatsapp_settings", self.whatsapp_settings))
        
        # Commandes admin
        self.application.add_handler(CommandHandler("admin", self.admin_panel))
        self.application.add_handler(CommandHandler("generate_code", self.generate_code))
        self.application.add_handler(CommandHandler("stats", self.stats))
        self.application.add_handler(CommandHandler("upgrade", self.upgrade_bot))
        self.application.add_handler(CommandHandler("commands", self.manage_commands))
        
        # Handlers de messages
        self.application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self.handle_message))
        
    def get_main_keyboard(self):
        """Clavier principal pour les utilisateurs"""
        keyboard = [
            [KeyboardButton("🔑 Utiliser Code"), KeyboardButton("💎 S'abonner")],
            [KeyboardButton("🔗 Connecter WhatsApp"), KeyboardButton("📊 Statut")],
            [KeyboardButton("⚙️ Paramètres WhatsApp"), KeyboardButton("🆘 Aide")],
            [KeyboardButton("📱 Menu Principal")]
        ]
        return ReplyKeyboardMarkup(keyboard, resize_keyboard=True, input_field_placeholder="Choisissez une option...")

    def get_admin_keyboard(self):
        """Clavier pour les administrateurs"""
        keyboard = [
            [KeyboardButton("🔑 Générer Code"), KeyboardButton("📊 Statistiques")],
            [KeyboardButton("🔄 Mise à Jour"), KeyboardButton("⚙️ Commandes")],
            [KeyboardButton("📱 Menu Principal"), KeyboardButton("👥 Utilisateurs")],
            [KeyboardButton("⚙️ Paramètres WhatsApp")]
        ]
        return ReplyKeyboardMarkup(keyboard, resize_keyboard=True, input_field_placeholder="Options administrateur...")

    def get_connection_keyboard(self):
        """Clavier pour les options de connexion"""
        keyboard = [
            [KeyboardButton("📱 QR Code"), KeyboardButton("🔢 Pairing Code")],
            [KeyboardButton("🎯 Essai 24h Gratuit"), KeyboardButton("📱 Menu Principal")]
        ]
        return ReplyKeyboardMarkup(keyboard, resize_keyboard=True, input_field_placeholder="Choisissez la méthode...")

    def get_trial_keyboard(self):
        """Clavier pour les options d'essai"""
        keyboard = [
            [KeyboardButton("🎯 Essai 24h Gratuit"), KeyboardButton("💎 Acheter Premium")],
            [KeyboardButton("📱 Menu Principal")]
        ]
        return ReplyKeyboardMarkup(keyboard, resize_keyboard=True, input_field_placeholder="Choisissez une option...")

    def get_settings_keyboard(self):
        """Clavier pour les paramètres WhatsApp"""
        keyboard = [
            [KeyboardButton("🔇 Activer Mode Silencieux"), KeyboardButton("🔊 Désactiver Mode Silencieux")],
            [KeyboardButton("🔒 Activer Mode Privé"), KeyboardButton("🔓 Désactiver Mode Privé")],
            [KeyboardButton("👥 Gérer Accès"), KeyboardButton("📱 Menu Principal")]
        ]
        return ReplyKeyboardMarkup(keyboard, resize_keyboard=True, input_field_placeholder="Paramètres WhatsApp...")

    def escape_markdown(self, text):
        """Échapper les caractères spéciaux Markdown"""
        escape_chars = r'\_*[]()~`>#+-=|{}.!'
        return re.sub(f'([{re.escape(escape_chars)}])', r'\\\1', text)

    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        user = update.effective_user
        chat_id = update.effective_chat.id
        
        # Enregistrer l'utilisateur
        await self.register_user(chat_id, user.first_name, user.username)
        
        welcome_text = self.escape_markdown(f"""
🤖 Bienvenue sur NOVA-MD Premium 🤖

Service de Bot WhatsApp Automatisé avec Sessions Persistantes

🎯 Fonctionnalités Premium:
• Commandes audio avancées
• Gestion de médias intelligente  
• Sessions WhatsApp permanentes
• Support prioritaire 24/7
• Mises à jour automatiques
• Mode silencieux
• Contrôle d'accès

🔐 Système d'Accès Unique:
• 1 code d'accès = 1 utilisateur
• 1 utilisateur = 1 device WhatsApp  
• Session permanente selon la durée

Utilisez les boutons ci-dessous pour naviguer!
        """)
        
        await update.message.reply_text(
            welcome_text, 
            reply_markup=self.get_main_keyboard(),
            parse_mode='MarkdownV2'
        )
        
    async def show_main_menu(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat_id = update.effective_chat.id
        
        # Vérifier si admin pour afficher le clavier approprié
        if chat_id in ADMIN_IDS:
            menu_text = self.escape_markdown("⚡ Menu Principal NOVA-MD\n\nChoisissez une option:")
            await update.message.reply_text(
                menu_text,
                reply_markup=self.get_admin_keyboard(),
                parse_mode='MarkdownV2'
            )
        else:
            menu_text = self.escape_markdown("⚡ Menu Principal NOVA-MD\n\nChoisissez une option:")
            await update.message.reply_text(
                menu_text,
                reply_markup=self.get_main_keyboard(),
                parse_mode='MarkdownV2'
            )

    async def use_code(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat_id = update.effective_chat.id
        
        code_text = self.escape_markdown("""
🔑 Activation du code d'accès

Veuillez entrer le code que vous avez reçu de l'administrateur:

Format: NOVA-XXXXXXX

Important:
• Un code ne peut être utilisé qu'UNE SEULE FOIS
• Un code = Un utilisateur = Un device WhatsApp
• Votre session sera permanente selon la durée du code
        """)
        
        await update.message.reply_text(
            code_text,
            parse_mode='MarkdownV2',
            reply_markup=ReplyKeyboardRemove()
        )
        
        context.user_data['waiting_for_code'] = True

    async def subscribe_info(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        subscribe_text = self.escape_markdown(f"""
💎 Abonnement NOVA-MD Premium

Comment obtenir l'accès:
1. Contactez l'administrateur {SUPPORT_CONTACT}
2. Choisissez votre formule préférée
3. Recevez votre code d'accès unique
4. Utilisez le bouton 🔑 Utiliser Code

Formules disponibles:
• 1 mois - Session permanente 30 jours
• 3 mois - Session permanente 90 jours
• 6 mois - Session permanente 180 jours  
• 1 an - Session permanente 365 jours

Avantages inclus:
🔐 Session WhatsApp PERMANENTE
📱 1 code = 1 utilisateur = 1 device
⚡ Connexion QR Code ou Pairing Code
🔇 Mode silencieux
🔒 Contrôle d'accès
🛡️ Support prioritaire 24/7
🔄 Mises à jour automatiques

Contact pour abonnement:
{SUPPORT_CONTACT}
        """)
        
        await update.message.reply_text(
            subscribe_text, 
            reply_markup=self.get_main_keyboard(),
            parse_mode='MarkdownV2'
        )

    async def connect_options(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat_id = update.effective_chat.id
        
        # Vérifier si l'utilisateur a un accès actif
        access = await self.check_user_access(chat_id)
        
        if not access['hasAccess']:
            await update.message.reply_text(
                self.escape_markdown("""
🔗 Options de Connexion WhatsApp

📱 Mode Essai Gratuit (24h):
• Session WhatsApp temporaire
• Fonctionnalités de base
• Parfaite pour tester

💎 Premium (Recommandé):
• Session PERMANENTE
• Toutes les fonctionnalités
• Support prioritaire

Choisissez une option:
                """),
                parse_mode='MarkdownV2',
                reply_markup=self.get_trial_keyboard()
            )
            return
            
        access_text = self.escape_markdown(f"""
🔗 Choisissez la méthode de connexion:

📱 QR Code - Scannez avec l'appareil photo
🔢 Pairing Code - Entrez un code numérique

💡 Session permanente active jusqu'au {access.get('endDate', 'N/A')}
        """)
        
        await update.message.reply_text(
            access_text,
            reply_markup=self.get_connection_keyboard(),
            parse_mode='MarkdownV2'
        )

    async def start_trial_session(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat_id = update.effective_chat.id
        user = update.effective_user
        
        await update.message.reply_text(
            self.escape_markdown("🎯 Démarrage de votre essai gratuit 24h!\n\nCration de votre session WhatsApp..."),
            parse_mode='MarkdownV2'
        )
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(f"{NODE_API_URL}/api/sessions/create", json={
                    'chat_id': str(chat_id),
                    'user_name': user.first_name,
                    'method': 'qr',
                    'persistent': False
                }) as response:
                    result = await response.json()
                    
                    if result.get('success'):
                        await update.message.reply_text(
                            self.escape_markdown("""
✅ Essai activé pour 24 heures!

Vous pouvez maintenant connecter WhatsApp.
Choisissez la méthode de connexion:
                            """),
                            parse_mode='MarkdownV2',
                            reply_markup=self.get_connection_keyboard()
                        )
                    else:
                        error_msg = result.get('error', 'Erreur inconnue')
                        await update.message.reply_text(
                            self.escape_markdown(f"❌ Impossible de créer l'essai\n\nErreur: {error_msg}\n\nRéessayez ou contactez le support."),
                            parse_mode='MarkdownV2'
                        )
        except Exception as e:
            await update.message.reply_text(
                self.escape_markdown("❌ Erreur de connexion\n\nLe serveur ne répond pas. Réessayez plus tard."),
                parse_mode='MarkdownV2'
            )

    async def connect_whatsapp_qr(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat_id = update.effective_chat.id
        user = update.effective_user
        
        # Vérifier l'accès
        access_check = await self.check_user_access(chat_id)
        
        if not access_check['hasAccess']:
            await update.message.reply_text(
                self.escape_markdown("❌ Accès non autorisé\n\nVous n'avez pas d'abonnement actif."),
                parse_mode='MarkdownV2',
                reply_markup=self.get_main_keyboard()
            )
            return
        
        # Vérifier si une session active existe déjà
        existing_session = await self.get_user_session(chat_id)
        if existing_session and existing_session.get('status') == 'connected':
            session_days = await self.get_session_days(existing_session.get('created_at'))
            await update.message.reply_text(
                self.escape_markdown(f"""
✅ Session déjà active!

Session permanente active depuis {session_days} jours
Active jusqu'au {access_check.get('endDate', 'N/A')}
                """),
                parse_mode='MarkdownV2',
                reply_markup=self.get_main_keyboard()
            )
            return
            
        # Créer une nouvelle session QR
        await update.message.reply_text(
            self.escape_markdown("🔄 Génération du QR Code..."),
            parse_mode='MarkdownV2'
        )
        
        session_data = await self.create_whatsapp_session(chat_id, user.first_name, 'qr')
        if session_data and 'qr_code' in session_data:
            qr = qrcode.QRCode()
            qr.add_data(session_data['qr_code'])
            
            img_buffer = io.BytesIO()
            qr.make_image().save(img_buffer, format='PNG')
            img_buffer.seek(0)
            
            instructions = self.escape_markdown(f"""
📱 Connexion WhatsApp - QR Code

1. Ouvrez WhatsApp → Paramètres
2. Appareils liés → Lier un appareil  
3. Scannez le QR code ci-dessous
4. Attendez la confirmation

🔐 SESSION PERMANENTE
Valable jusqu'au {access_check.get('endDate', 'N/A')}

⏱️ Le QR expire dans 2 minutes
            """)
            
            await update.message.reply_text(instructions, parse_mode='MarkdownV2')
            await update.message.reply_photo(
                img_buffer, 
                caption="Scannez-moi avec WhatsApp 📲",
                reply_markup=self.get_main_keyboard()
            )
            
        else:
            await update.message.reply_text(
                self.escape_markdown("❌ Erreur lors de la création de la session."),
                reply_markup=self.get_main_keyboard()
            )

    async def connect_whatsapp_pairing(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat_id = update.effective_chat.id
        user = update.effective_user
        
        # Vérifier l'accès
        access_check = await self.check_user_access(chat_id)
        
        if not access_check['hasAccess']:
            await update.message.reply_text(
                self.escape_markdown("❌ Accès non autorisé"),
                parse_mode='MarkdownV2',
                reply_markup=self.get_main_keyboard()
            )
            return
        
        await update.message.reply_text(
            self.escape_markdown("🔢 Démarrage du processus Pairing...\n\nGénération du code de pairing..."),
            parse_mode='MarkdownV2'
        )
        
        # Démarrer le pairing sur le serveur Node.js
        session_data = await self.create_whatsapp_session(chat_id, user.first_name, 'pairing')
        
        if session_data and session_data.get('success'):
            await update.message.reply_text(
                self.escape_markdown("✅ Processus pairing démarré\n\nLe serveur génère votre code de pairing...\nPatientez quelques secondes."),
                parse_mode='MarkdownV2',
                reply_markup=self.get_main_keyboard()
            )
        else:
            await update.message.reply_text(
                self.escape_markdown("❌ Erreur démarrage pairing"),
                parse_mode='MarkdownV2',
                reply_markup=self.get_main_keyboard()
            )

    async def handle_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        text = update.message.text
        chat_id = update.effective_chat.id
        
        # Gestion des boutons du clavier
        if text == "🔑 Utiliser Code":
            await self.use_code(update, context)
        elif text == "💎 S'abonner":
            await self.subscribe_info(update, context)
        elif text == "🔗 Connecter WhatsApp":
            await self.connect_options(update, context)
        elif text == "📊 Statut":
            await self.status(update, context)
        elif text == "🆘 Aide":
            await self.help(update, context)
        elif text == "📱 Menu Principal":
            await self.show_main_menu(update, context)
        elif text == "⚙️ Paramètres WhatsApp":
            await self.whatsapp_settings(update, context)
        elif text == "📱 QR Code":
            await self.connect_whatsapp_qr(update, context)
        elif text == "🔢 Pairing Code":
            await self.connect_whatsapp_pairing(update, context)
        elif text == "🎯 Essai 24h Gratuit":
            await self.start_trial_session(update, context)
        elif text == "💎 Acheter Premium":
            await self.subscribe_info(update, context)
        
        # Boutons admin
        elif text == "🔑 Générer Code" and chat_id in ADMIN_IDS:
            await update.message.reply_text(
                self.escape_markdown("""
🔑 Génération de code

Utilisez la commande: /generate_code <plan> <durée>

Exemples:
/generate_code monthly
/generate_code yearly 365
/generate_code custom 60
                """),
                parse_mode='MarkdownV2'
            )
        elif text == "📊 Statistiques" and chat_id in ADMIN_IDS:
            await self.stats(update, context)
        elif text == "🔄 Mise à Jour" and chat_id in ADMIN_IDS:
            await self.upgrade_bot(update, context)
        elif text == "⚙️ Commandes" and chat_id in ADMIN_IDS:
            await self.manage_commands(update, context)
        elif text == "👥 Utilisateurs" and chat_id in ADMIN_IDS:
            await self.show_users(update, context)
        
        # Boutons paramètres WhatsApp
        elif text == "🔇 Activer Mode Silencieux":
            await self.handle_whatsapp_settings(update, context)
        elif text == "🔊 Désactiver Mode Silencieux":
            await self.handle_whatsapp_settings(update, context)
        elif text == "🔒 Activer Mode Privé":
            await self.handle_whatsapp_settings(update, context)
        elif text == "🔓 Désactiver Mode Privé":
            await self.handle_whatsapp_settings(update, context)
        elif text == "👥 Gérer Accès":
            await self.handle_whatsapp_settings(update, context)
        
        # Gestion des codes d'accès
        elif context.user_data.get('waiting_for_code'):
            await self.process_access_code(update, context)

    async def process_access_code(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat_id = update.effective_chat.id
        code = update.message.text.strip().upper()
        
        # Validation basique du format
        if not re.match(r'^NOVA-[A-Z0-9]{7}$', code):
            await update.message.reply_text(
                self.escape_markdown("""
❌ Format de code invalide

Le code doit être au format: NOVA-XXXXXXX

Veuillez réessayer:
                """),
                parse_mode='MarkdownV2'
            )
            return
            
        await update.message.reply_text(
            self.escape_markdown("🔄 Validation du code..."), 
            parse_mode='MarkdownV2'
        )
        
        # Valider le code via l'API
        validation_result = await self.validate_access_code(chat_id, code)
        
        if validation_result.get('valid'):
            plan = validation_result.get('plan', 'monthly')
            duration = validation_result.get('duration', 30)
            end_date = validation_result.get('expiresAt')
            
            success_text = self.escape_markdown(f"""
✅ Code validé avec succès!

🎉 Félicitations! Votre accès NOVA-MD Premium est maintenant activé.

📋 Détails de votre abonnement:
• Plan: {plan.capitalize()}
• Durée: {duration} jours
• Expire le: {datetime.fromisoformat(end_date).strftime('%d/%m/%Y')}

🔐 Fonctionnalités activées:
• Session WhatsApp PERMANENTE
• Commandes audio avancées
• Gestion de médias intelligente
• Mode silencieux
• Contrôle d'accès
• Support prioritaire 24/7

🚀 Prochaine étape:
Utilisez le bouton 🔗 Connecter WhatsApp pour commencer!
            """)
            
            await update.message.reply_text(
                success_text, 
                parse_mode='MarkdownV2',
                reply_markup=self.get_main_keyboard()
            )
            
        else:
            error_reason = validation_result.get('reason', 'Erreur inconnue')
            await update.message.reply_text(
                self.escape_markdown(f"❌ Code invalide\n\nRaison: {error_reason}\n\nVérifiez le code ou contactez {SUPPORT_CONTACT}"),
                parse_mode='MarkdownV2',
                reply_markup=self.get_main_keyboard()
            )
            
        context.user_data['waiting_for_code'] = False

    async def admin_panel(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat_id = update.effective_chat.id
        
        if chat_id not in ADMIN_IDS:
            await update.message.reply_text("❌ Accès réservé aux administrateurs.")
            return
            
        admin_text = self.escape_markdown("""
👑 Panel Administrateur NOVA-MD

Commandes disponibles:
• /generate_code - Créer un code d'accès
• /stats - Statistiques du système
• /upgrade - Mettre à jour le bot
• /commands - Gérer les commandes

Utilisez les boutons ci-dessous ou les commandes!
        """)
        
        await update.message.reply_text(
            admin_text,
            reply_markup=self.get_admin_keyboard(),
            parse_mode='MarkdownV2'
        )

    async def generate_code(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat_id = update.effective_chat.id
        
        if chat_id not in ADMIN_IDS:
            await update.message.reply_text("❌ Accès réservé aux administrateurs.")
            return
            
        args = context.args
        plan = 'monthly'
        duration = None
        
        if args:
            plan = args[0]
            if len(args) > 1 and args[1].isdigit():
                duration = int(args[1])
        
        await update.message.reply_text(
            self.escape_markdown(f"🔄 Génération d'un code {plan}..."),
            parse_mode='MarkdownV2'
        )
        
        code_result = await self.generate_access_code(plan, duration)
        
        if code_result and code_result.get('success'):
            code_text = self.escape_markdown(f"""
✅ Code d'accès généré

🔑 Code: `{code_result['code']}`
📅 Plan: {plan}
⏱️ Durée: {code_result['duration']} jours
📅 Expire le: {datetime.fromisoformat(code_result['expiresAt']).strftime('%d/%m/%Y')}

Instructions:
• Le code est utilisable par UN SEUL utilisateur
• UN SEUL device WhatsApp peut être connecté
• Valable jusqu'à la date d'expiration
            """)
            await update.message.reply_text(code_text, parse_mode='MarkdownV2')
        else:
            await update.message.reply_text("❌ Erreur lors de la génération du code.")

    async def stats(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat_id = update.effective_chat.id
        
        if chat_id not in ADMIN_IDS:
            await update.message.reply_text("❌ Accès réservé aux administrateurs.")
            return
            
        stats_data = await self.get_system_stats()
        
        if stats_data:
            stats_text = self.escape_markdown(f"""
📊 Statistiques NOVA-MD

👥 Utilisateurs:
• Abonnés actifs: {stats_data.get('activeSubs', 0)}
• Codes générés: {stats_data.get('totalCodes', 0)}
• Codes utilisés: {stats_data.get('usedCodes', 0)}

📱 Sessions:
• Total: {stats_data.get('sessionStats', {}).get('total', 0)}
• Connectées: {stats_data.get('sessionStats', {}).get('connected', 0)}
• Sessions permanentes: {stats_data.get('sessionStats', {}).get('persistentSessions', 0)}

🔄 Système:
• Version: v{stats_data.get('version', 'N/A')}
• Uptime: {stats_data.get('uptime', 0)} secondes
• Statut: {stats_data.get('resourceStats', {}).get('status', 'N/A')}
            """)
            await update.message.reply_text(stats_text, parse_mode='MarkdownV2')
        else:
            await update.message.reply_text("❌ Erreur lors de la récupération des statistiques.")

    async def upgrade_bot(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat_id = update.effective_chat.id
        
        if chat_id not in ADMIN_IDS:
            await update.message.reply_text("❌ Accès réservé aux administrateurs.")
            return
            
        await update.message.reply_text(
            self.escape_markdown("🔄 Vérification des mises à jour..."),
            parse_mode='MarkdownV2'
        )

    async def manage_commands(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat_id = update.effective_chat.id
        
        if chat_id not in ADMIN_IDS:
            await update.message.reply_text("❌ Accès réservé aux administrateurs.")
            return
            
        commands_info = await self.get_commands_info()
        
        if commands_info:
            commands_text = self.escape_markdown(f"""
⚙️ Gestion des Commandes

📁 Commandes personnalisées: {commands_info.get('total', 0)}

Catégories:
Utilisez /help pour voir toutes les commandes disponibles.

Pour ajouter une commande:
Contactez le développeur ou utilisez le système de mise à jour.
            """)
            await update.message.reply_text(commands_text, parse_mode='MarkdownV2')
        else:
            await update.message.reply_text(
                self.escape_markdown("❌ Erreur lors de la récupération des commandes."),
                parse_mode='MarkdownV2'
            )

    async def status(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat_id = update.effective_chat.id
        
        access_check = await self.check_user_access(chat_id)
        
        if access_check['hasAccess']:
            session_info = await self.get_user_session(chat_id)
            
            status_text = self.escape_markdown(f"""
✅ Statut NOVA-MD Premium

💎 Abonnement:
• Plan: {access_check.get('plan', 'N/A').capitalize()}
• Jours restants: {access_check.get('daysLeft', 0)}
• Expire le: {access_check.get('endDate', 'N/A')}

📱 Session WhatsApp:
• Statut: {'🟢 Connectée' if session_info and session_info.get('status') == 'connected' else '🔴 Non connectée'}
• Type: Session permanente
• Device: Unique (1 code = 1 device)

💡 Votre session reste active automatiquement!
            """)
        else:
            status_text = self.escape_markdown(f"""
❌ Statut: Accès non activé

Vous n'avez pas d'abonnement actif.

📋 Pour obtenir l'accès:
1. Contactez {SUPPORT_CONTACT}
2. Choisissez votre formule
3. Recevez votre code unique
4. Utilisez le bouton 🔑 Utiliser Code
            """)
        
        await update.message.reply_text(
            status_text, 
            parse_mode='MarkdownV2',
            reply_markup=self.get_main_keyboard()
        )

    async def help(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        help_text = self.escape_markdown(f"""
🆘 Aide NOVA-MD

Navigation:
Utilisez les boutons du clavier pour naviguer facilement!

Fonctionnalités:
• 🔑 Utiliser Code - Activer un code d'accès
• 💎 S'abonner - Informations abonnement  
• 🔗 Connecter WhatsApp - Options connexion
• 📊 Statut - Vérifier votre statut
• ⚙️ Paramètres WhatsApp - Configurer le bot
• 📱 Menu Principal - Retour au menu

Sessions Permanentes:
• Abonnés: Session WhatsApp permanente
• 1 code = 1 utilisateur = 1 device
• Pas de reconnexion nécessaire

Support:
Problèmes? Contactez {SUPPORT_CONTACT}
        """)
        
        await update.message.reply_text(
            help_text, 
            parse_mode='MarkdownV2',
            reply_markup=self.get_main_keyboard()
        )

    async def whatsapp_settings(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat_id = update.effective_chat.id
        
        # Vérifier l'accès
        access_check = await self.check_user_access(chat_id)
        if not access_check['hasAccess']:
            await update.message.reply_text(
                self.escape_markdown("❌ Accès requis\n\nVous devez avoir un abonnement actif."),
                parse_mode='MarkdownV2',
                reply_markup=self.get_main_keyboard()
            )
            return
        
        # Récupérer les paramètres WhatsApp
        settings = await self.get_whatsapp_settings(chat_id)
        
        settings_text = self.escape_markdown(f"""
⚙️ Paramètres WhatsApp - NOVA-MD

🔇 Mode Silencieux: {'✅ ACTIVÉ' if settings.get('silent_mode') else '❌ Désactivé'}
• Seul vous voyez les réponses aux commandes
• Les autres ne voient ni la commande ni le résultat

🔒 Mode Privé: {'✅ ACTIVÉ' if settings.get('private_mode') else '❌ Désactivé'}
• Contrôle qui peut utiliser votre bot WhatsApp
• Numéros autorisés: {', '.join(settings.get('allowed_users', [])) if settings.get('allowed_users') else 'Tout le monde'}

Commandes WhatsApp disponibles:
!silent - Activer/désactiver le mode silencieux
!private - Gérer les accès
!private +237612345678 - Autoriser un numéro
!private all - Autoriser tout le monde
!settings - Voir les paramètres
!help - Aide complète
        """)
        
        await update.message.reply_text(
            settings_text,
            parse_mode='MarkdownV2',
            reply_markup=self.get_settings_keyboard()
        )

    async def handle_whatsapp_settings(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        text = update.message.text
        chat_id = update.effective_chat.id
        
        if text == "🔇 Activer Mode Silencieux":
            result = await self.update_whatsapp_settings(chat_id, {'silent_mode': True})
            if result.get('success'):
                await update.message.reply_text(
                    self.escape_markdown("✅ Mode silencieux activé\n\nSur WhatsApp:\n• Seul vous verrez les réponses\n• Les autres ne voient rien\n• Utilisez `!silent` pour désactiver"),
                    parse_mode='MarkdownV2',
                    reply_markup=self.get_main_keyboard()
                )
            else:
                await update.message.reply_text("❌ Erreur activation mode silencieux")
                
        elif text == "🔊 Désactiver Mode Silencieux":
            result = await self.update_whatsapp_settings(chat_id, {'silent_mode': False})
            if result.get('success'):
                await update.message.reply_text(
                    self.escape_markdown("✅ Mode silencieux désactivé\n\nSur WhatsApp:\n• Tout le monde voit les commandes\n• Les réponses sont publiques"),
                    parse_mode='MarkdownV2',
                    reply_markup=self.get_main_keyboard()
                )
            else:
                await update.message.reply_text("❌ Erreur désactivation mode silencieux")
                
        elif text == "🔒 Activer Mode Privé":
            result = await self.update_whatsapp_settings(chat_id, {
                'private_mode': True,
                'allowed_users': ['all']
            })
            if result.get('success'):
                await update.message.reply_text(
                    self.escape_markdown("✅ Mode privé activé\n\nSur WhatsApp:\n• Seuls les utilisateurs autorisés peuvent utiliser le bot\n• Par défaut: tout le monde est autorisé\n• Utilisez `!private +237612345678` sur WhatsApp pour restreindre"),
                    parse_mode='MarkdownV2',
                    reply_markup=self.get_main_keyboard()
                )
            else:
                await update.message.reply_text("❌ Erreur activation mode privé")
                
        elif text == "🔓 Désactiver Mode Privé":
            result = await self.update_whatsapp_settings(chat_id, {
                'private_mode': False,
                'allowed_users': []
            })
            if result.get('success'):
                await update.message.reply_text(
                    self.escape_markdown("✅ Mode privé désactivé\n\nSur WhatsApp:\n• Tout le monde peut utiliser le bot\n• Aucune restriction d'accès"),
                    parse_mode='MarkdownV2',
                    reply_markup=self.get_main_keyboard()
                )
            else:
                await update.message.reply_text("❌ Erreur désactivation mode privé")
                
        elif text == "👥 Gérer Accès":
            await update.message.reply_text(
                self.escape_markdown("""
👥 Gestion des accès WhatsApp

Pour restreindre l'accès à des numéros spécifiques:

1. Allez sur WhatsApp
2. Envoyez cette commande à votre bot:
`!private +237612345678 +237698765432`

Pour autoriser tout le monde:
`!private all`

Exemples:
• `!private +237612345678` - Un seul numéro
• `!private +237612345678 +237698765432` - Deux numéros
• `!private all` - Tout le monde (par défaut)
                """),
                parse_mode='MarkdownV2',
                reply_markup=self.get_main_keyboard()
            )

    async def show_users(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Afficher les utilisateurs actifs"""
        chat_id = update.effective_chat.id
        
        if chat_id not in ADMIN_IDS:
            return
            
        users_data = await self.get_active_users()
        
        if users_data:
            users_list = '\n'.join([f'• {user.get("first_name", "N/A")} ({user.get("chat_id", "N/A")})' for user in users_data[:10]])
            users_text = self.escape_markdown(f"""
👥 Utilisateurs Actifs

Total: {len(users_data)} utilisateurs

Derniers utilisateurs:
{users_list}

Pour plus de détails: /stats
            """)
            await update.message.reply_text(users_text, parse_mode='MarkdownV2')
        else:
            await update.message.reply_text("❌ Aucun utilisateur actif trouvé.")

    # Méthodes d'API pour communiquer avec le serveur Node.js
    async def register_user(self, chat_id, name, username):
        """Enregistrer un utilisateur dans la base"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(f"{NODE_API_URL}/api/users/register", json={
                    'chat_id': str(chat_id),
                    'name': name,
                    'username': username
                }) as response:
                    return await response.json()
        except Exception as e:
            logger.error(f"Erreur enregistrement utilisateur: {e}")
            return None

    async def validate_access_code(self, chat_id, code):
        """Valider un code d'accès"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(f"{NODE_API_URL}/api/auth/validate-code", json={
                    'chat_id': str(chat_id),
                    'code': code
                }) as response:
                    return await response.json()
        except Exception as e:
            logger.error(f"Erreur validation code: {e}")
            return {'valid': False, 'reason': 'Erreur système'}

    async def check_user_access(self, chat_id):
        """Vérifier l'accès d'un utilisateur"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{NODE_API_URL}/api/auth/access/{chat_id}") as response:
                    return await response.json()
        except Exception as e:
            logger.error(f"Erreur vérification accès: {e}")
            return {'hasAccess': False, 'reason': 'Erreur système'}

    async def generate_access_code(self, plan, duration):
        """Générer un code d'accès"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(f"{NODE_API_URL}/api/admin/generate-code", json={
                    'plan': plan,
                    'duration': duration
                }) as response:
                    return await response.json()
        except Exception as e:
            logger.error(f"Erreur génération code: {e}")
            return None

    async def get_system_stats(self):
        """Obtenir les statistiques système"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{NODE_API_URL}/api/admin/stats") as response:
                    return await response.json()
        except Exception as e:
            logger.error(f"Erreur récupération stats: {e}")
            return None

    async def create_whatsapp_session(self, chat_id, name, method='qr'):
        """Créer une session WhatsApp"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(f"{NODE_API_URL}/api/sessions/create", json={
                    'chat_id': str(chat_id),
                    'user_name': name,
                    'method': method,
                    'persistent': True
                }) as response:
                    return await response.json()
        except Exception as e:
            logger.error(f"Erreur création session: {e}")
            return None

    async def get_user_session(self, chat_id):
        """Obtenir la session d'un utilisateur"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{NODE_API_URL}/api/sessions/user/{chat_id}") as response:
                    return await response.json()
        except Exception as e:
            logger.error(f"Erreur récupération session: {e}")
            return None

    async def get_commands_info(self):
        """Obtenir les informations des commandes"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{NODE_API_URL}/api/commands/info") as response:
                    return await response.json()
        except Exception as e:
            logger.error(f"Erreur récupération commandes: {e}")
            return None

    async def get_active_users(self):
        """Obtenir les utilisateurs actifs"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{NODE_API_URL}/api/users/active") as response:
                    return await response.json()
        except Exception as e:
            logger.error(f"Erreur récupération utilisateurs: {e}")
            return []

    async def get_whatsapp_settings(self, user_id):
        """Obtenir les paramètres WhatsApp"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{NODE_API_URL}/api/user/{user_id}/whatsapp-settings") as response:
                    return await response.json()
        except Exception as e:
            logger.error(f"Erreur récupération paramètres: {e}")
            return {'silent_mode': False, 'private_mode': False, 'allowed_users': []}

    async def update_whatsapp_settings(self, user_id, settings):
        """Mettre à jour les paramètres WhatsApp"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(f"{NODE_API_URL}/api/user/{user_id}/whatsapp-settings", json=settings) as response:
                    return await response.json()
        except Exception as e:
            return {'success': False, 'error': str(e)}

    async def get_active_sessions_count(self):
        """Récupérer le nombre de sessions actives"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{NODE_API_URL}/api/sessions/health") as response:
                    data = await response.json()
                    return data.get('connected', 0)
        except:
            return 0

    async def get_session_days(self, created_at):
        """Calculer le nombre de jours depuis la création de la session"""
        if not created_at:
            return 0
        try:
            if created_at.endswith('Z'):
                created_at = created_at[:-1] + '+00:00'
            created_date = datetime.fromisoformat(created_at)
            return (datetime.now() - created_date).days
        except:
            return 0

    async def send_message(self, chat_id, text, parse_mode='MarkdownV2'):
        """Envoyer un message"""
        try:
            await self.application.bot.send_message(
                chat_id=chat_id,
                text=text,
                parse_mode=parse_mode
            )
        except Exception as e:
            logger.error(f"Erreur envoi message: {e}")

    def run(self):
        """Démarrer le bot"""
        logger.info("🤖 Démarrage du bot Telegram NOVA-MD...")
        self.application.run_polling()

if __name__ == '__main__':
    bot = NovaMDTelegramBot()
    bot.run()
