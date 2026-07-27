using { com.bookshop as bookshop } from '../db/domain-model';

service AdminService {
    entity Books as SELECT from bookshop.Books;
    entity Authors as SELECT from bookshop.Authors;
}  