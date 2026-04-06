export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          display_name: string | null;
          email: string | null;
          handicap: number | null;
          home_course: string | null;
          avatar_url: string | null;
          subscription_status: 'free' | 'trial' | 'active' | 'cancelled' | 'expired';
          subscription_expires_at: string | null;
          hardware_kit_ordered: boolean;
          ble_device_id: string | null;
          expo_push_token: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database['public']['Tables']['profiles']['Row']> & { id: string };
        Update: Partial<Database['public']['Tables']['profiles']['Row']>;
      };
      rounds: {
        Row: {
          id: string;
          user_id: string;
          course_id: string | null;
          course_name: string;
          date: string;
          total_score: number | null;
          total_par: number | null;
          score_to_par: number | null;
          total_putts: number | null;
          holes_played: number;
          status: 'recording' | 'uploading' | 'processing' | 'ready' | 'failed';
          reel_url: string | null;
          reel_duration_seconds: number | null;
          music_track_id: string | null;
          thumbnail_url: string | null;
          is_published: boolean;
          share_token: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database['public']['Tables']['rounds']['Row']> & {
          user_id: string;
          course_name: string;
        };
        Update: Partial<Database['public']['Tables']['rounds']['Row']>;
      };
      scores: {
        Row: {
          id: string;
          round_id: string;
          hole_number: number;
          strokes: number;
          putts: number;
          penalty_strokes: number;
          is_pickup: boolean;
          fairway_hit: boolean | null;
          green_in_regulation: boolean | null;
          score_to_par: number | null;
          created_at: string;
        };
        Insert: Partial<Database['public']['Tables']['scores']['Row']> & {
          round_id: string;
          hole_number: number;
          strokes: number;
        };
        Update: Partial<Database['public']['Tables']['scores']['Row']>;
      };
      shots: {
        Row: {
          id: string;
          round_id: string;
          user_id: string;
          hole_number: number;
          shot_number: number;
          clip_url: string | null;
          processed_clip_url: string | null;
          gps_latitude: number | null;
          gps_longitude: number | null;
          detection_method: string | null;
          duration_seconds: number | null;
          is_penalty: boolean;
          is_excluded: boolean;
          sort_order: number | null;
          created_at: string;
        };
        Insert: Partial<Database['public']['Tables']['shots']['Row']> & {
          round_id: string;
          user_id: string;
          hole_number: number;
          shot_number: number;
        };
        Update: Partial<Database['public']['Tables']['shots']['Row']>;
      };
      processing_jobs: {
        Row: {
          id: string;
          round_id: string;
          user_id: string;
          status: string;
          progress_percent: number;
          modal_job_id: string | null;
          error_message: string | null;
          processing_time_seconds: number | null;
          clips_detected: number | null;
          started_at: string | null;
          completed_at: string | null;
          created_at: string;
        };
        Insert: Partial<Database['public']['Tables']['processing_jobs']['Row']> & {
          round_id: string;
          user_id: string;
        };
        Update: Partial<Database['public']['Tables']['processing_jobs']['Row']>;
      };
      courses: {
        Row: {
          id: string;
          name: string;
          location_name: string | null;
          state: string | null;
          country: string;
          latitude: number | null;
          longitude: number | null;
          holes_count: number;
          par_total: number | null;
          slope_rating: number | null;
          course_rating: number | null;
          source: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database['public']['Tables']['courses']['Row']> & { name: string };
        Update: Partial<Database['public']['Tables']['courses']['Row']>;
      };
      hardware_orders: {
        Row: {
          id: string;
          user_id: string;
          stripe_payment_intent_id: string | null;
          stripe_customer_id: string | null;
          amount_cents: number;
          currency: string;
          status: 'pending' | 'paid' | 'shipped' | 'delivered' | 'returned' | 'refunded';
          kit_type: 'standard' | 'premium';
          shipping_name: string | null;
          shipping_address_line1: string | null;
          shipping_address_line2: string | null;
          shipping_city: string | null;
          shipping_state: string | null;
          shipping_postal_code: string | null;
          shipping_country: string;
          tracking_number: string | null;
          shipped_at: string | null;
          delivered_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database['public']['Tables']['hardware_orders']['Row']> & {
          user_id: string;
          amount_cents: number;
        };
        Update: Partial<Database['public']['Tables']['hardware_orders']['Row']>;
      };
      music_tracks: {
        Row: {
          id: string;
          name: string;
          artist: string | null;
          duration_seconds: number | null;
          genre: string | null;
          mood: string | null;
          file_url: string;
          preview_url: string | null;
          is_active: boolean;
          sort_order: number;
          created_at: string;
        };
        Insert: Partial<Database['public']['Tables']['music_tracks']['Row']> & {
          id: string;
          name: string;
          file_url: string;
        };
        Update: Partial<Database['public']['Tables']['music_tracks']['Row']>;
      };
    };
  };
};
