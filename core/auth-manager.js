const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const log = require('../utils/logger')(module);

class AuthManager {
    constructor() {
        this.supabase = createClient(config.supabase.url, config.supabase.key);
        this.initDatabase();
    }

    async initDatabase() {
        log.success("✅ AuthManager initialisé avec Supabase");
    }

    async generateAccessCode(plan = 'monthly', durationDays = null, createdBy = 'admin') {
        try {
            const code = 'NOVA-' + Math.random().toString(36).substring(2, 10).toUpperCase();
            
            let finalDuration = durationDays;
            if (!finalDuration) {
                finalDuration = config.subscriptions.defaultDurations[plan] || 30;
            }

            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + finalDuration);

            const { data, error } = await this.supabase
                .from('access_codes')
                .insert([{
                    code: code,
                    plan: plan,
                    duration_days: finalDuration,
                    status: 'active',
                    created_by: createdBy,
                    created_at: new Date().toISOString(),
                    expires_at: expiresAt.toISOString(),
                    used: false,
                    max_usage: 1
                }])
                .select();

            if (error) throw error;
            log.success(`🔑 Code d'accès généré: ${code} (Plan: ${plan}, Durée: ${finalDuration} jours)`);
            return { code, duration: finalDuration, expiresAt: expiresAt.toISOString() };
        } catch (error) {
            log.error('❌ Erreur génération code:', error);
            return null;
        }
    }

    async validateAccessCode(code, userId) {
        try {
            const { data, error } = await this.supabase
                .from('access_codes')
                .select('*')
                .eq('code', code)
                .eq('status', 'active')
                .eq('used', false)
                .gt('expires_at', new Date().toISOString())
                .single();

            if (error || !data) {
                return { valid: false, reason: 'Code invalide, expiré ou déjà utilisé' };
            }

            if (data.used_by && data.used_by !== userId) {
                return { valid: false, reason: 'Ce code a déjà été utilisé par un autre utilisateur' };
            }

            const { error: updateError } = await this.supabase
                .from('access_codes')
                .update({ 
                    used: true,
                    used_by: userId,
                    used_at: new Date().toISOString()
                })
                .eq('code', code);

            if (updateError) throw updateError;

            const subscription = await this.createSubscription(userId, data.plan, data.duration_days);
            
            return { 
                valid: true, 
                plan: data.plan,
                duration: data.duration_days,
                subscription,
                persistentSession: true
            };
        } catch (error) {
            log.error('❌ Erreur validation code:', error);
            return { valid: false, reason: 'Erreur système' };
        }
    }

    async createSubscription(userId, plan = 'monthly', durationDays = 30) {
        try {
            const startDate = new Date();
            const endDate = new Date();
            endDate.setDate(endDate.getDate() + durationDays);

            const { data, error } = await this.supabase
                .from('subscriptions')
                .insert([{
                    user_id: userId,
                    plan: plan,
                    duration_days: durationDays,
                    status: 'active',
                    start_date: startDate.toISOString(),
                    end_date: endDate.toISOString(),
                    created_at: new Date().toISOString(),
                    access_code_used: null
                }])
                .select();

            if (error) throw error;
            
            log.success(`💎 Abonnement créé pour ${userId}: ${plan} (${durationDays} jours) jusqu'au ${endDate.toLocaleDateString()}`);
            return data[0];
        } catch (error) {
            log.error('❌ Erreur création abonnement:', error);
            return null;
        }
    }

    async checkUserAccess(userId) {
        try {
            const { data, error } = await this.supabase
                .from('subscriptions')
                .select('*')
                .eq('user_id', userId)
                .eq('status', 'active')
                .gt('end_date', new Date().toISOString())
                .single();

            if (error || !data) {
                return { 
                    hasAccess: false, 
                    reason: 'Aucun abonnement actif'
                };
            }

            const daysLeft = Math.ceil((new Date(data.end_date) - new Date()) / (1000 * 60 * 60 * 24));
            const endDate = new Date(data.end_date).toLocaleDateString('fr-FR');
            
            return { 
                hasAccess: true, 
                subscription: data,
                daysLeft: daysLeft,
                plan: data.plan,
                duration: data.duration_days,
                endDate: endDate,
                persistentSession: true
            };
        } catch (error) {
            log.error('❌ Erreur vérification accès:', error);
            return { hasAccess: false, reason: 'Erreur système' };
        }
    }

    async getStats() {
        try {
            const { data: codesData, error: codesError } = await this.supabase
                .from('access_codes')
                .select('*');

            const { data: subsData, error: subsError } = await this.supabase
                .from('subscriptions')
                .select('*');

            if (codesError || subsError) throw codesError || subsError;

            const totalCodes = codesData.length;
            const usedCodes = codesData.filter(code => code.used).length;
            const activeSubs = subsData.filter(sub => 
                sub.status === 'active' && new Date(sub.end_date) > new Date()
            ).length;

            const expiredSubs = subsData.filter(sub => 
                sub.status === 'active' && new Date(sub.end_date) <= new Date()
            ).length;

            return {
                totalCodes,
                usedCodes,
                activeSubs,
                expiredSubs,
                plans: {
                    monthly: subsData.filter(sub => sub.plan === 'monthly').length,
                    '3months': subsData.filter(sub => sub.plan === '3months').length,
                    '6months': subsData.filter(sub => sub.plan === '6months').length,
                    yearly: subsData.filter(sub => sub.plan === 'yearly').length,
                    custom: subsData.filter(sub => sub.plan === 'custom').length
                }
            };
        } catch (error) {
            log.error('❌ Erreur récupération stats:', error);
            return null;
        }
    }

    async getUserSubscription(userId) {
        try {
            const { data, error } = await this.supabase
                .from('subscriptions')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            return data;
        } catch (error) {
            return null;
        }
    }

    async cancelSubscription(userId) {
        try {
            const { error } = await this.supabase
                .from('subscriptions')
                .update({
                    status: 'cancelled',
                    cancelled_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('user_id', userId)
                .eq('status', 'active');

            if (error) throw error;

            log.success(`❌ Abonnement annulé pour ${userId}`);
            return { success: true };

        } catch (error) {
            log.error('❌ Erreur annulation abonnement:', error);
            return { success: false, error: error.message };
        }
    }

    async getActiveSubscriptions() {
        try {
            const { data, error } = await this.supabase
                .from('subscriptions')
                .select('*')
                .eq('status', 'active')
                .gt('end_date', new Date().toISOString());

            return data || [];
        } catch (error) {
            log.error('❌ Erreur récupération abonnements actifs:', error);
            return [];
        }
    }

    async getExpiringSubscriptions(days = 7) {
        try {
            const soon = new Date();
            soon.setDate(soon.getDate() + days);

            const { data, error } = await this.supabase
                .from('subscriptions')
                .select('*')
                .eq('status', 'active')
                .lt('end_date', soon.toISOString())
                .gt('end_date', new Date().toISOString());

            return data || [];
        } catch (error) {
            log.error('❌ Erreur récupération abonnements expirants:', error);
            return [];
        }
    }

    async getAccessCodes(status = 'all') {
        try {
            let query = this.supabase
                .from('access_codes')
                .select('*')
                .order('created_at', { ascending: false });

            if (status === 'active') {
                query = query.eq('used', false).gt('expires_at', new Date().toISOString());
            } else if (status === 'used') {
                query = query.eq('used', true);
            } else if (status === 'expired') {
                query = query.eq('used', false).lt('expires_at', new Date().toISOString());
            }

            const { data, error } = await query;

            if (error) throw error;
            return data || [];
        } catch (error) {
            log.error('❌ Erreur récupération codes:', error);
            return [];
        }
    }

    async getUserSettings(userId) {
        try {
            const { data, error } = await this.supabase
                .from('user_settings')
                .select('*')
                .eq('user_id', userId)
                .single();

            if (error && error.code !== 'PGRST116') throw error;
            
            return data || {
                user_id: userId,
                silent_mode: false,
                private_mode: false,
                allowed_users: [],
                created_at: new Date().toISOString()
            };
        } catch (error) {
            log.error('❌ Erreur récupération paramètres utilisateur:', error);
            return {
                user_id: userId,
                silent_mode: false,
                private_mode: false,
                allowed_users: [],
                created_at: new Date().toISOString()
            };
        }
    }

    async updateUserSettings(userId, settings) {
        try {
            const existing = await this.getUserSettings(userId);
            const newSettings = { ...existing, ...settings, updated_at: new Date().toISOString() };
            
            const { error } = await this.supabase
                .from('user_settings')
                .upsert(newSettings, { onConflict: 'user_id' });
                
            if (error) throw error;
            
            return { success: true, settings: newSettings };
        } catch (error) {
            log.error('❌ Erreur mise à jour paramètres:', error);
            return { success: false, error: error.message };
        }
    }
}

module.exports = AuthManager; 
