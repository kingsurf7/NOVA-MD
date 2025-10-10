const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const log = require('../utils/logger')(module);

class TrialManager {
    constructor() {
        this.supabase = createClient(config.supabase.url, config.supabase.key);
        this.trialDuration = 24 * 60 * 60 * 1000; // 24 heures
    }

    async createTrialSession(userId, userData) {
        try {
            const trialExpires = new Date(Date.now() + this.trialDuration);
            
            const { data, error } = await this.supabase
                .from('trial_sessions')
                .insert([{
                    user_id: userId,
                    user_data: userData,
                    expires_at: trialExpires.toISOString(),
                    created_at: new Date().toISOString()
                }])
                .select();

            if (error) throw error;

            log.success(`🎯 Session essai créée pour ${userId}`);
            return { 
                success: true, 
                expiresAt: trialExpires,
                isTrial: true 
            };

        } catch (error) {
            log.error('❌ Erreur création essai:', error);
            return { success: false, error: error.message };
        }
    }

    async checkTrialAccess(userId) {
        try {
            const { data, error } = await this.supabase
                .from('trial_sessions')
                .select('*')
                .eq('user_id', userId)
                .gt('expires_at', new Date().toISOString())
                .single();

            return { 
                hasTrial: !!data, 
                expiresAt: data?.expires_at,
                isActive: !!data 
            };

        } catch (error) {
            return { hasTrial: false, isActive: false };
        }
    }
}

module.exports = TrialManager;
